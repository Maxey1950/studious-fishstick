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
    }
  /** The underlying text document changed — from undo, a text editor on the
   * same file, or a Live Share participant. */
  | { type: 'update'; xml: string };

/** Webview -> extension host. */
export type WebviewMessage =
  /** The webview finished booting and is ready for an `init`. */
  | { type: 'ready' }
  /** The user changed the blocks; `xml` is the full serialized workspace. */
  | { type: 'edit'; xml: string }
  /** Something went wrong in the webview and should surface to the user. */
  | { type: 'error'; message: string }
  /** Non-fatal note (e.g. unknown MakeCode block types were stubbed). */
  | { type: 'info'; message: string }
  /** The embedded MakeCode editor never responded; offer the built-in one. */
  | { type: 'editorUnavailable' };
