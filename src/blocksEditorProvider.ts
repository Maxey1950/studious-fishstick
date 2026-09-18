import * as vscode from 'vscode';
import type { HostMessage, RendererName, WebviewMessage } from './protocol';
import {
  SHARED_FILES,
  changedFiles,
  isShared,
  isEmpty,
  withDeclaredFiles,
  type ProjectText,
} from './shared/projectFiles';
import { recordVersion, describeVersion, type Version } from './shared/history';
import { minimalReplacement } from './textDiff';

/**
 * A `.blocks` editor backed by the file's own text document.
 *
 * Being a *text* custom editor is the whole trick behind collaboration: Live
 * Share synchronizes text documents between participants, but has no API for
 * syncing webview or binary custom-editor state. Because every block change is
 * written back through a `WorkspaceEdit` on the real document, Live Share
 * replicates it like any other edit, and each participant's webview re-renders
 * from the document it already has.
 */
export class BlocksEditorProvider implements vscode.CustomTextEditorProvider {
  public static readonly viewType = 'blocksEditor.blocks';

  /**
   * The project files beside each open document, as last read or written.
   *
   * Kept so a change can be recognized as one we caused. Writing `assets.json`
   * makes the watcher fire, which would look exactly like a collaborator
   * painting a sprite, and be sent back to the editor that just produced it.
   */
  private readonly projectFiles = new Map<string, ProjectText>();

  /** Pending auto-saves, one per document, so a burst of edits is one write. */
  private readonly saveTimers = new Map<string, number>();

  /**
   * Recent states of each open document, newest first.
   *
   * Kept for as long as the editor is open, which is the window in which
   * something can go wrong and be noticed.
   */
  private readonly history = new Map<string, Version[]>();

  /** Posts a diagnostic message to the active webview, when there is one. */
  private notify?: (message: HostMessage) => void;

  constructor(private readonly context: vscode.ExtensionContext) {}

  /**
   * Registers the editor, optionally with a provider the caller already holds.
   *
   * The restore command needs to reach the same instance the editors run on,
   * since the history lives there.
   */
  public static register(
    context: vscode.ExtensionContext,
    provider = new BlocksEditorProvider(context)
  ): vscode.Disposable {
    return vscode.window.registerCustomEditorProvider(
      BlocksEditorProvider.viewType,
      provider,
      {
        // Keep the Blockly workspace alive when the tab is backgrounded, so
        // scroll position and selection survive tab switches.
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: true,
      }
    );
  }

  public async resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    token: vscode.CancellationToken
  ): Promise<void> {
    const webview = webviewPanel.webview;
    webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
    };
    // Read the project files before the webview exists.
    //
    // Nothing may be awaited between showing the webview and listening to it.
    // The webview posts `ready` the moment its script runs, and a message sent
    // before there is a listener is dropped — so an await here means no `init`
    // ever reaches it, the editor never loads the document, and nothing it does
    // can be saved.
    await this.loadProjectFiles(document);
    // The state it opened in is a version worth being able to get back to.
    this.remember(document, document.getText());

    const engine = this.engineFor(document);
    webview.html =
      engine === 'makecode'
        ? this.buildMakeCodeHtml(webview, this.embedElementFor(document))
        : this.buildBlocklyHtml(webview);

    /**
     * The XML this webview has handed us recently.
     *
     * When the resulting document change echoes back through
     * `onDidChangeTextDocument` we recognize it and skip re-rendering, which
     * would otherwise interrupt the user mid-gesture. Recently, not last: a
     * drag produces several in a row, and the echo of an earlier one arrives
     * after the webview has moved on — so matching only the newest let the
     * others through as if a collaborator had sent them.
     */
    const recentFromWebview: string[] = [];
    const rememberFromWebview = (xml: string): void => {
      recentFromWebview.push(xml);
      if (recentFromWebview.length > 24) {
        recentFromWebview.shift();
      }
    };

    const post = (message: HostMessage): void => {
      void webview.postMessage(message);
    };
    // writeBack runs outside this closure; give it a way to reach this webview.
    this.notify = post;

    const disposables: vscode.Disposable[] = [];

    const watcher = this.watchProjectFiles(document, (files) =>
      post({ type: 'projectUpdate', files })
    );
    if (watcher) {
      disposables.push(watcher);
    }

    disposables.push(
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (event.document.uri.toString() !== document.uri.toString()) {
          return;
        }
        if (event.contentChanges.length === 0) {
          return;
        }
        const text = event.document.getText();
        this.remember(document, text);
        if (recentFromWebview.includes(text)) {
          return;
        }
        post({ type: 'update', xml: text });
      })
    );

    disposables.push(
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('blocksEditor.engine', document.uri)) {
          // Switching engines replaces the webview contents wholesale.
          void vscode.window.showInformationMessage(
            'Blocks Editor: reopen this file to switch editors.'
          );
          return;
        }
        if (event.affectsConfiguration('blocksEditor', document.uri)) {
          // The webview rebuilds its workspace if the renderer changed, and
          // otherwise just picks up the new settings.
          post({ type: 'init', ...this.initPayload(document, webview) });
        }
      })
    );

    disposables.push(
      webview.onDidReceiveMessage(async (message: WebviewMessage) => {
        switch (message.type) {
          case 'ready':
            post({ type: 'init', ...this.initPayload(document, webview) });
            return;
          case 'edit':
            rememberFromWebview(message.xml);
            this.remember(document, message.xml);
            await this.writeBack(document, message.xml);
            this.scheduleSave(document);
            return;
          case 'projectFiles':
            await this.writeProjectFiles(document, message.files);
            return;
          case 'error':
            void vscode.window.showErrorMessage(`Blocks Editor: ${message.message}`);
            return;
          case 'info':
            void vscode.window.showWarningMessage(`Blocks Editor: ${message.message}`);
            return;
          case 'save':
            await this.save(document);
            return;
          case 'editorUnavailable':
            await this.offerBuiltInEditor(document);
            return;
        }
      })
    );

    webviewPanel.onDidDispose(() => {
      const pending = this.saveTimers.get(document.uri.toString());
      if (pending !== undefined) {
        clearTimeout(pending);
        this.saveTimers.delete(document.uri.toString());
        // The edits are already in the document; saving now means closing the
        // tab does not put up a prompt for changes the user never thinks of as
        // unsaved.
        void this.save(document);
      }
      for (const disposable of disposables) {
        disposable.dispose();
      }
    });

    token.onCancellationRequested(() => webviewPanel.dispose());
  }

  private initPayload(
    document: vscode.TextDocument,
    webview: vscode.Webview
  ): Omit<Extract<HostMessage, { type: 'init' }>, 'type'> {
    const config = vscode.workspace.getConfiguration('blocksEditor', document.uri);
    const mediaUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'vendor', 'blockly', 'media')
    );
    return {
      xml: document.getText(),
      files: this.projectFiles.get(document.uri.toString()) ?? {},
      renderer: config.get<RendererName>('renderer', 'pxt'),
      editable: !this.isReadOnly(document),
      debounceMs: config.get<number>('writeDebounceMs', 100),
      remoteApplyDelayMs: config.get<number>('remoteApplyDelayMs', 150),
      embedElement: this.embedElementFor(document),
      highlightRemoteChanges: config.get<boolean>('highlightRemoteChanges', true),
      // vscode.dev serves its pages with an embedder policy that desktop VS
      // Code does not set, and the difference decides how the editor's frames
      // have to be loaded.
      requireCorp: vscode.env.uiKind === vscode.UIKind.Web,
      // Blockly resolves its sprites and cursors relative to this, and wants a
      // trailing slash.
      mediaUri: `${mediaUri.toString()}/`,
    };
  }

  private isReadOnly(document: vscode.TextDocument): boolean {
    // `TextDocument` has no read-only flag; the file system provider's
    // capability is the closest signal available to a web extension. A Live
    // Share guest on a read-only session gets a non-writable provider here.
    return vscode.workspace.fs.isWritableFileSystem(document.uri.scheme) === false;
  }

  /**
   * Writes the serialized workspace back to the document as the narrowest edit
   * that produces it, so concurrent Live Share edits to other blocks survive.
   */
  /**
   * Saves the document, if it has anything to save.
   *
   * Writing a block change only makes the document dirty; a dirty file is
   * enough for Live Share, which replicates unsaved editor state, but it leaves
   * the tab marked and MakeCode has no notion of an unsaved project for a user
   * to reason about.
   */
  private async save(document: vscode.TextDocument): Promise<void> {
    if (document.isUntitled || !document.isDirty) {
      return;
    }
    try {
      await document.save();
    } catch (error) {
      void vscode.window.showErrorMessage(
        `Blocks Editor: could not save the file (${describeError(error)}).`
      );
    }
  }

  /**
   * Saves once the edits stop, rather than on each one.
   *
   * A drag produces an edit every few frames and each one would otherwise be a
   * write to disk. Waiting for the gesture to finish makes it one.
   */
  private scheduleSave(document: vscode.TextDocument): void {
    const config = vscode.workspace.getConfiguration('blocksEditor', document.uri);
    if (!config.get<boolean>('autoSave', true)) {
      return;
    }

    const key = document.uri.toString();
    const pending = this.saveTimers.get(key);
    if (pending !== undefined) {
      clearTimeout(pending);
    }
    this.saveTimers.set(
      key,
      setTimeout(() => {
        this.saveTimers.delete(key);
        void this.save(document);
      }, config.get<number>('autoSaveDelayMs', 800)) as unknown as number
    );
  }

  /** Adds a state to this document's history. */
  private remember(document: vscode.TextDocument, xml: string): void {
    const key = document.uri.toString();
    this.history.set(key, recordVersion(this.history.get(key) ?? [], xml, Date.now()));
  }

  /**
   * Offers the recent states of a document and restores the chosen one.
   *
   * Restoring is an ordinary edit, so it reaches collaborators the way every
   * other change does — which is the point. Someone whose blocks vanished can
   * put them back for everybody, not just for themselves.
   */
  public async restoreVersion(uri: vscode.Uri): Promise<void> {
    const document = await vscode.workspace.openTextDocument(uri);
    const versions = this.history.get(uri.toString()) ?? [];
    const current = document.getText();
    const choices = versions.filter((version) => version.xml !== current);

    if (!choices.length) {
      void vscode.window.showInformationMessage(
        versions.length
          ? 'Blocks Editor: this file has not changed since it was opened.'
          : 'Blocks Editor: no earlier versions have been recorded for this file yet.'
      );
      return;
    }

    const now = Date.now();
    const picked = await vscode.window.showQuickPick(
      choices.map((version, index) => ({
        label: describeVersion(version, now),
        description: index === 0 ? 'the state just before the latest change' : undefined,
        version,
      })),
      {
        title: 'Restore blocks from an earlier version',
        placeHolder: 'Everyone working on this file will see the restored blocks',
      }
    );
    if (!picked) {
      return;
    }

    await this.writeBack(document, picked.version.xml);
    await this.save(document);
  }

  /** Where a project file lives: beside the `.blocks` file. */
  private siblingUri(document: vscode.TextDocument, name: string): vscode.Uri {
    return vscode.Uri.joinPath(document.uri, '..', name);
  }

  /** Reads the project files beside the document into the cache. */
  private async loadProjectFiles(document: vscode.TextDocument): Promise<ProjectText> {
    const files: ProjectText = {};
    // Sharing the rest of the project is a bonus on top of sharing the blocks.
    // Nothing here is allowed to stop the editor opening.

    // The named files, plus whatever .jres sit beside the document — the image
    // and tilemap data are in those, and their names are not fixed, so the
    // folder is listed rather than guessed at.
    const names = new Set<string>(SHARED_FILES);
    try {
      const folder = vscode.Uri.joinPath(document.uri, '..');
      for (const [entry, kind] of await vscode.workspace.fs.readDirectory(folder)) {
        if (kind === vscode.FileType.File && isShared(entry)) {
          names.add(entry);
        }
      }
    } catch {
      // A file outside any listable folder; the named files are still tried.
    }

    await Promise.all(
      [...names].map(async (name) => {
        try {
          const bytes = await vscode.workspace.fs.readFile(this.siblingUri(document, name));
          files[name] = new TextDecoder().decode(bytes);
        } catch {
          // Not every project has every file, and a project may be a lone
          // `.blocks` file with nothing beside it at all.
        }
      })
    );
    this.projectFiles.set(document.uri.toString(), files);
    return files;
  }

  /**
   * Writes the project files the editor produced, and shares them.
   *
   * These are ordinary files in the workspace folder, so Live Share replicates
   * them exactly as it replicates the `.blocks` document — which is why there is
   * still no Live Share code anywhere in this extension.
   */
  private async writeProjectFiles(
    document: vscode.TextDocument,
    incoming: ProjectText
  ): Promise<void> {
    const key = document.uri.toString();
    const known = this.projectFiles.get(key) ?? {};
    const changed = changedFiles(known, incoming);
    if (!Object.keys(changed).length) {
      return;
    }

    // An `assets.json` MakeCode does not know about is invisible in the editor,
    // which is worse than not sharing it — the sprites would be on disk and
    // missing from every picker.
    if (changed['assets.json'] !== undefined) {
      const config = changed['pxt.json'] ?? known['pxt.json'];
      if (config !== undefined) {
        const declared = withDeclaredFiles(config, ['assets.json']);
        if (declared !== config) {
          changed['pxt.json'] = declared;
        }
      }
    }

    const written: ProjectText = { ...known };
    for (const [name, content] of Object.entries(changed)) {
      try {
        await vscode.workspace.fs.writeFile(
          this.siblingUri(document, name),
          new TextEncoder().encode(content)
        );
        written[name] = content;
      } catch (error) {
        // A read-only workspace, or a Live Share guest without write access.
        // The blocks still sync; say so once rather than failing silently.
        void vscode.window.showWarningMessage(
          `Blocks Editor: could not save ${name} (${describeError(error)}). ` +
            'Blocks are still being shared.'
        );
        return;
      }
    }
    this.projectFiles.set(key, written);
  }

  /**
   * Watches the project files beside the document.
   *
   * Changes we made ourselves are filtered out here rather than in the webview:
   * writing `assets.json` fires the watcher, and without this it would arrive
   * back at the editor that produced it looking like somebody else's edit.
   */
  private watchProjectFiles(
    document: vscode.TextDocument,
    onChanged: (files: ProjectText) => void
  ): vscode.Disposable | undefined {
    let watcher: vscode.FileSystemWatcher;
    try {
      const folder = vscode.Uri.joinPath(document.uri, '..');
      watcher = vscode.workspace.createFileSystemWatcher(
        // The named files plus any .jres, where the image and tilemap data live.
        new vscode.RelativePattern(folder, `{${SHARED_FILES.join(',')},*.jres}`)
      );
    } catch {
      // A file outside any workspace folder, or a file system that cannot be
      // watched. The blocks still sync; the rest of the project just will not
      // arrive on its own.
      return undefined;
    }

    const reread = async (uri: vscode.Uri): Promise<void> => {
      const name = uri.path.split('/').pop();
      if (!name) {
        return;
      }
      const key = document.uri.toString();
      const known = this.projectFiles.get(key) ?? {};
      let content: string;
      try {
        content = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
      } catch {
        return;
      }
      if (content === known[name]) {
        // Our own write coming back.
        return;
      }
      if (isEmpty(content) && !isEmpty(known[name])) {
        // A half-written file caught mid-save is not somebody emptying it.
        return;
      }
      this.projectFiles.set(key, { ...known, [name]: content });
      onChanged({ [name]: content });
    };

    watcher.onDidChange((uri) => void reread(uri));
    watcher.onDidCreate((uri) => void reread(uri));
    return watcher;
  }

  private async writeBack(document: vscode.TextDocument, xml: string): Promise<void> {
    const current = document.getText();
    const change = minimalReplacement(current, xml);
    if (!change) {
      return;
    }

    const edit = new vscode.WorkspaceEdit();
    edit.replace(
      document.uri,
      new vscode.Range(document.positionAt(change.start), document.positionAt(change.end)),
      change.replacement
    );

    const applied = await vscode.workspace.applyEdit(edit);
    // Echoed to the webview so the outcome shows up in the same console as the
    // rest of the sync trace, rather than in a separate host log.
    this.notify?.({
      type: 'wrote',
      ok: applied,
      detail: applied ? `${change.replacement.length} chars at ${change.start}` : 'applyEdit refused',
    });
    if (!applied) {
      void vscode.window.showErrorMessage(
        'Blocks Editor: could not write the block change to the file.'
      );
    }
  }

  /**
   * The embedded editor can fail for reasons outside this extension: a blocked
   * network, or vscode.dev's `require-corp` embedder policy refusing an iframe
   * that does not set COEP itself. Rather than leaving a dead panel, offer the
   * built-in editor, which needs no network at all.
   */
  private async offerBuiltInEditor(document: vscode.TextDocument): Promise<void> {
    const useBuiltIn = 'Use the built-in editor';
    const choice = await vscode.window.showWarningMessage(
      'Blocks Editor: the MakeCode Arcade editor could not be loaded. ' +
        'This can happen when makecode.com is unreachable, or when the host refuses to embed it.',
      useBuiltIn,
      'Keep waiting'
    );
    if (choice !== useBuiltIn) {
      return;
    }

    await vscode.workspace
      .getConfiguration('blocksEditor', document.uri)
      .update('engine', 'blockly', vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand('vscode.openWith', document.uri, 'default');
    await vscode.commands.executeCommand(
      'vscode.openWith',
      document.uri,
      BlocksEditorProvider.viewType
    );
  }

  private embedElementFor(document: vscode.TextDocument): EmbedElement {
    return vscode.workspace
      .getConfiguration('blocksEditor', document.uri)
      .get<EmbedElement>('embedElement', 'credentialless');
  }

  private engineFor(document: vscode.TextDocument): 'makecode' | 'blockly' {
    return vscode.workspace
      .getConfiguration('blocksEditor', document.uri)
      .get<'makecode' | 'blockly'>('engine', 'makecode');
  }

  /**
   * The MakeCode engine: a webview whose only content is an iframe of the real
   * Arcade editor, plus the bridge that keeps it and the document in step.
   */
  private buildMakeCodeHtml(webview: vscode.Webview, embedElement: EmbedElement): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'makecodeEditor.js')
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'blocksEditor.css')
    );
    const nonce = createNonce();

    // Both frame-src and object-src are opened to MakeCode, since the editor may
    // be embedded with an iframe or with <object>/<embed>; everything else stays
    // shut either way.
    // In every mode but `blob` the editor is a cross-origin document carrying
    // MakeCode's own policy, and this one governs only our small host page.
    //
    // `blob` is different: the editor's document is same-origin, so this policy
    // applies to MakeCode's bundle as well, and that bundle needs inline
    // scripts and eval (it compiles TypeScript in the browser). Those
    // allowances exist only in that mode, and only because being same-origin is
    // the sole way to apply a collaborator's change without reloading the whole
    // editor. Choosing `blob` is opting into running MakeCode's code beside our
    // own rather than walled off from it.
    const makecode =
      'https://arcade.makecode.com https://*.makecode.com https://cdn.makecode.com ' +
      'https://trg-arcade.userpxt.io';
    const sameOrigin = embedElement === 'blob';

    // A nonce and 'unsafe-inline' cannot coexist: per the CSP spec a nonce in
    // the source list makes 'unsafe-inline' ignored entirely. In same-origin
    // mode MakeCode's own inline scripts have to run — one of them carries its
    // configuration, and without it the editor cannot work out any of its URLs
    // — so that mode drops the nonce and allows our script by its source
    // instead.
    const scriptSrc = sameOrigin
      ? `script-src ${webview.cspSource} 'unsafe-inline' 'unsafe-eval' blob: ${makecode}`
      : `script-src 'nonce-${nonce}'`;

    const csp = [
      `default-src 'none'`,
      `frame-src ${makecode}${sameOrigin ? ' blob:' : ''}`,
      `object-src ${makecode}`,
      `child-src ${sameOrigin ? `blob: ${makecode}` : "'none'"}`,
      `img-src ${webview.cspSource} data: blob:${sameOrigin ? ` ${makecode}` : ''}`,
      `style-src ${webview.cspSource} 'unsafe-inline'${sameOrigin ? ` ${makecode}` : ''}`,
      `font-src ${webview.cspSource}${sameOrigin ? ` ${makecode} data:` : ''}`,
      `media-src ${webview.cspSource}${sameOrigin ? ` ${makecode} blob:` : ''}`,
      // The editor asks for its simulator's web manifest, which falls back to
      // default-src unless named.
      `manifest-src ${sameOrigin ? makecode : "'none'"}`,
      // webview.cspSource covers our own script's source map.
      `connect-src ${makecode} ${webview.cspSource}${sameOrigin ? ' blob: data:' : ''}`,
      sameOrigin ? `worker-src blob: ${makecode}` : `worker-src 'none'`,
      scriptSrc,
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${styleUri}" rel="stylesheet">
<title>MakeCode Arcade</title>
</head>
<body class="makecode-engine">
<div id="status" class="status" role="status" hidden></div>
${embedTag(embedElement)}
<script${sameOrigin ? '' : ` nonce="${nonce}"`} src="${scriptUri}"></script>
</body>
</html>`;
  }

  private buildBlocklyHtml(webview: vscode.Webview): string {
    const asset = (...parts: string[]): vscode.Uri =>
      webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', ...parts));

    const scriptUri = asset('blocksEditor.js');
    const styleUri = asset('blocksEditor.css');
    const nonce = createNonce();

    // Blockly injects inline <style> for its themes and renderers, and decodes
    // its sprites from data: URIs, hence 'unsafe-inline' on style-src and data:
    // on img-src. Scripts stay nonce-locked.
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} data: blob:`,
      `media-src ${webview.cspSource}`,
      // Blockly preloads its click and disconnect sounds with fetch(), which is
      // governed by connect-src rather than media-src.
      `connect-src ${webview.cspSource}`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${styleUri}" rel="stylesheet">
<title>Blocks Editor</title>
</head>
<body>
<div id="status" class="status" role="status" hidden></div>
<div id="blockly"></div>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

type EmbedElement = 'credentialless' | 'blob' | 'iframe' | 'object' | 'embed';

/**
 * The element that hosts the MakeCode editor.
 *
 * vscode.dev serves its pages with `Cross-Origin-Embedder-Policy: require-corp`,
 * under which a cross-origin iframe must assert COEP itself. MakeCode does not,
 * so a plain iframe is refused there — as are `<object>` and `<embed>`, which
 * current Chrome treats the same way.
 *
 * `credentialless` is the way through: Chrome added it precisely so a
 * require-corp document can embed cross-origin content lacking COEP, by loading
 * it without credentials and in ephemeral storage. That costs nothing here,
 * since the project reaches the editor over the controller protocol rather than
 * through its cookies or its own storage.
 *
 * The others are kept because a plain iframe does work in desktop VS Code, where
 * no such policy applies.
 */
function embedTag(kind: EmbedElement): string {
  const title = 'MakeCode Arcade editor';
  switch (kind) {
    case 'object':
      return `<object id="editor" type="text/html" title="${title}"></object>`;
    case 'embed':
      return `<embed id="editor" type="text/html" title="${title}">`;
    case 'iframe':
      return `<iframe id="editor" title="${title}" allow="autoplay; fullscreen"></iframe>`;
    case 'blob':
      // The webview builds the source itself, so this stays a plain iframe.
      // Deliberately not credentialless: that would partition the frame away
      // again and defeat the point of loading it same-origin.
      return `<iframe id="editor" title="${title}" allow="autoplay; fullscreen"></iframe>`;
    case 'credentialless':
    default:
      // `credentialless` is a boolean attribute; browsers without support ignore
      // it and treat this as an ordinary iframe.
      return `<iframe id="editor" title="${title}" credentialless allow="autoplay; fullscreen"></iframe>`;
  }
}

function createNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
