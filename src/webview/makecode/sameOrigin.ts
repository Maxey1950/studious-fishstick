/**
 * Loading the editor same-origin, so its workspace can be reached directly.
 *
 * Normally the editor is a cross-origin iframe: the only way to change what it
 * holds is `importproject`, which replaces the whole project and rebuilds the
 * editor. That is the reload collaborators see on every incoming change.
 *
 * Fetching MakeCode's page and loading it from a blob URL makes the document
 * same-origin with this webview — blob URLs inherit the origin of whoever
 * created them — at which point its live Blockly workspace is directly
 * reachable and a change can be applied surgically.
 *
 * Whether MakeCode runs correctly from a blob origin is not knowable without
 * trying it, so everything here reports what it finds rather than assuming.
 */
import { ARCADE_EDITOR_URL } from '../../shared/arcadeProtocol';

/** What a same-origin probe found inside the editor. */
export interface EditorReach {
  sameOrigin: boolean;
  /** Globals the editor exposes, which decide whether surgical updates work. */
  globals: string[];
  /** A Blockly workspace we can drive, when one is reachable. */
  workspace?: any;
  detail: string;
}

/**
 * Fetches the editor's HTML and returns a blob URL for it.
 *
 * A `<base>` is injected because the fetched markup refers to its assets
 * relatively; without one they would resolve against the blob URL and 404.
 */
export async function createBlobEditorUrl(): Promise<string> {
  const response = await fetch(ARCADE_EDITOR_URL, { credentials: 'omit' });
  if (!response.ok) {
    throw new Error(`MakeCode returned ${response.status}`);
  }

  const html = await response.text();
  const origin = new URL(ARCADE_EDITOR_URL).origin;
  const withBase = html.replace(
    /<head([^>]*)>/i,
    `<head$1><base href="${origin}/">`
  );
  if (!withBase.includes('<base')) {
    throw new Error('could not find a <head> to anchor the editor’s asset paths');
  }

  return URL.createObjectURL(new Blob([withBase], { type: 'text/html' }));
}

/**
 * Reports whether the editor's internals are reachable, and how.
 *
 * Touching a cross-origin frame's `document` throws; that throw is the test.
 */
export function probeEditor(frame: HTMLIFrameElement): EditorReach {
  const view = frame.contentWindow as any;

  try {
    // Throws for a cross-origin document, which is the answer we are after.
    void view.document.title;
  } catch {
    return {
      sameOrigin: false,
      globals: [],
      detail: 'cross-origin: only importproject is available, so changes reload the editor',
    };
  }

  const globals = ['Blockly', 'pxt', 'pxsim', 'pxtblockly'].filter(
    (name) => view[name] !== undefined
  );

  const workspace = findWorkspace(view);
  return {
    sameOrigin: true,
    globals,
    workspace,
    detail: workspace
      ? `same-origin, workspace reachable (globals: ${globals.join(', ') || 'none'})`
      : `same-origin but no workspace found (globals: ${globals.join(', ') || 'none'})`,
  };
}

/** Finds the editor's main Blockly workspace, however it is exposed. */
function findWorkspace(view: any): any {
  try {
    if (view.Blockly?.getMainWorkspace) {
      return view.Blockly.getMainWorkspace();
    }
    // pxt keeps its Blockly under its own namespace in some builds.
    if (view.pxtblockly?.getMainWorkspace) {
      return view.pxtblockly.getMainWorkspace();
    }
    const main = view.pxt?.editor?.mainWorkspace ?? view.pxt?.blocks?.getMainWorkspace?.();
    return main ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Applies block XML straight into the editor's workspace.
 *
 * This is the whole point of being same-origin: the editor's app, toolbox and
 * simulator stay up and only the canvas changes, where `importproject` would
 * have rebuilt everything. Scroll and zoom are restored so the view does not
 * jump under the user.
 */
export function applyBlocksDirectly(reach: EditorReach, view: any, xml: string): boolean {
  const workspace = reach.workspace;
  const Blockly = view.Blockly;
  if (!workspace || !Blockly?.Xml) {
    return false;
  }

  try {
    const dom = Blockly.utils.xml.textToDom(xml);
    const scroll = { x: workspace.scrollX, y: workspace.scrollY, scale: workspace.scale };

    Blockly.Events.disable();
    try {
      Blockly.Xml.clearWorkspaceAndLoadFromXml(dom, workspace);
    } finally {
      Blockly.Events.enable();
    }

    workspace.setScale?.(scroll.scale);
    workspace.scroll?.(scroll.x, scroll.y);
    return true;
  } catch {
    return false;
  }
}

/** Reads the editor's current blocks without waiting for it to save. */
export function readBlocksDirectly(reach: EditorReach, view: any): string | undefined {
  const workspace = reach.workspace;
  const Blockly = view.Blockly;
  if (!workspace || !Blockly?.Xml) {
    return undefined;
  }
  try {
    return Blockly.Xml.domToText(Blockly.Xml.workspaceToDom(workspace));
  } catch {
    return undefined;
  }
}
