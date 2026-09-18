/** Messages exchanged between the extension host and the Blockly webview. */

export type RendererName = 'pxt' | 'zelos' | 'geras' | 'thrasos';

/** Extension host -> webview. */
export type HostMessage =
  | {
      type: 'init';
      xml: string;
      renderer: RendererName;
      editable: boolean;
      mediaUri: string;
      debounceMs: number;
      /** Idle time before a remote change is applied (MakeCode engine). */
      remoteApplyDelayMs: number;
      /** Which strategy is hosting the editor; `blob` means same-origin. */
      embedElement: string;
      /** Whether to mark a collaborator's changes on the canvas as they land. */
      highlightRemoteChanges: boolean;
      /**
       * True where the host page sets `Cross-Origin-Embedder-Policy:
       * require-corp` — vscode.dev does, desktop VS Code does not. It decides
       * whether the editor's own frames need the `credentialless` escape hatch,
       * which costs them their storage partition and so is not applied for free.
       */
      requireCorp: boolean;
      /**
       * The rest of the project as it stands on disk — `pxt.json`,
       * `assets.json`, `main.ts` — so the editor opens with the extensions and
       * sprites everyone else has, not just the blocks.
       */
      files: Record<string, string>;
    }
  /** The underlying text document changed — from undo, a text editor on the
   * same file, or a Live Share participant. */
  | { type: 'update'; xml: string }
  /** Diagnostic: the host's result of writing an edit, echoed for the console. */
  | { type: 'wrote'; ok: boolean; detail: string }
  /** A project file beside the document changed: someone added an extension or
   * painted a sprite. */
  | { type: 'projectUpdate'; files: Record<string, string> };

/** Webview -> extension host. */
export type WebviewMessage =
  /** The webview finished booting and is ready for an `init`. */
  | { type: 'ready' }
  /** The user changed the blocks; `xml` is the full serialized workspace. */
  | { type: 'edit'; xml: string }
  /** The editor changed part of the project other than its blocks — an added
   * extension, an edited sprite — and it should be written beside the file. */
  | { type: 'projectFiles'; files: Record<string, string> }
  /** The user pressed Ctrl+S inside the editor, where VS Code cannot see it. */
  | { type: 'save' }
  /** Something went wrong in the webview and should surface to the user. */
  | { type: 'error'; message: string }
  /** Non-fatal note (e.g. unknown MakeCode block types were stubbed). */
  | { type: 'info'; message: string }
  /** The embedded MakeCode editor never responded; offer the built-in one. */
  | { type: 'editorUnavailable' };
