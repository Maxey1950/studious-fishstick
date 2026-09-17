import * as vscode from 'vscode';
import type { HostMessage, RendererName, WebviewMessage } from './protocol';
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

  constructor(private readonly context: vscode.ExtensionContext) {}

  public static register(context: vscode.ExtensionContext): vscode.Disposable {
    return vscode.window.registerCustomEditorProvider(
      BlocksEditorProvider.viewType,
      new BlocksEditorProvider(context),
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
    const engine = this.engineFor(document);
    webview.html =
      engine === 'makecode'
        ? this.buildMakeCodeHtml(webview, this.embedElementFor(document))
        : this.buildBlocklyHtml(webview);

    /**
     * The last XML this webview handed us. When the resulting document change
     * echoes back through `onDidChangeTextDocument` we recognize it and skip
     * re-rendering, which would otherwise interrupt the user mid-gesture.
     */
    let lastTextFromWebview: string | undefined;

    const post = (message: HostMessage): void => {
      void webview.postMessage(message);
    };

    const disposables: vscode.Disposable[] = [];

    disposables.push(
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (event.document.uri.toString() !== document.uri.toString()) {
          return;
        }
        if (event.contentChanges.length === 0) {
          return;
        }
        const text = event.document.getText();
        if (text === lastTextFromWebview) {
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
            lastTextFromWebview = message.xml;
            await this.writeBack(document, message.xml);
            return;
          case 'error':
            void vscode.window.showErrorMessage(`Blocks Editor: ${message.message}`);
            return;
          case 'info':
            void vscode.window.showWarningMessage(`Blocks Editor: ${message.message}`);
            return;
          case 'editorUnavailable':
            await this.offerBuiltInEditor(document);
            return;
        }
      })
    );

    webviewPanel.onDidDispose(() => {
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
      renderer: config.get<RendererName>('renderer', 'pxt'),
      editable: !this.isReadOnly(document),
      debounceMs: config.get<number>('writeDebounceMs', 250),
      remoteApplyDelayMs: config.get<number>('remoteApplyDelayMs', 900),
      embedElement: this.embedElementFor(document),
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
      'https://arcade.makecode.com https://*.makecode.com https://cdn.makecode.com';
    const sameOrigin = embedElement === 'blob';

    const csp = [
      `default-src 'none'`,
      `frame-src ${makecode}${sameOrigin ? ' blob:' : ''}`,
      `object-src ${makecode}`,
      `img-src ${webview.cspSource} data: blob:${sameOrigin ? ` ${makecode}` : ''}`,
      `style-src ${webview.cspSource} 'unsafe-inline'${sameOrigin ? ` ${makecode}` : ''}`,
      `font-src ${webview.cspSource}${sameOrigin ? ` ${makecode} data:` : ''}`,
      `media-src ${webview.cspSource}${sameOrigin ? ` ${makecode}` : ''}`,
      // Fetching the editor's own markup, which `blob` mode reads and re-hosts.
      `connect-src ${makecode}`,
      sameOrigin ? `worker-src blob: ${makecode}` : `worker-src 'none'`,
      sameOrigin
        ? `script-src 'nonce-${nonce}' 'unsafe-inline' 'unsafe-eval' blob: ${makecode}`
        : `script-src 'nonce-${nonce}'`,
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
<script nonce="${nonce}" src="${scriptUri}"></script>
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
