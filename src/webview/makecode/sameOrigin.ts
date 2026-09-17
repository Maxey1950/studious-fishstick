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

  // A <base> fixes document-relative URLs, but not root-relative ones: `/foo`
  // always resolves against the origin and ignores <base> entirely. The
  // editor's config is full of them — "/---worker", "/---tsworker" and friends
  // — so on a blob origin they pointed at paths that do not exist, the fetch
  // failed, and the editor showed its "Oops" screen. Make them absolute.
  const absolute = html.replace(/"\/---/g, `"${origin}/---`);

  // A blob URL carries no query string, so "?controller=1&ws=iframe" is lost
  // when the page is re-hosted. Without it MakeCode decides it is not embedded,
  // drops into read-only sandbox mode with an in-memory workspace, and never
  // asks the host for a project — there is nothing to edit and no workspace to
  // drive. Restoring the query from inside the document, before its own scripts
  // run, puts it back in controller mode.
  const patched = absolute.replace(
    /<head([^>]*)>/i,
    `<head$1><base href="${origin}/">${controllerShim()}${WORKER_SHIM}`
  );
  if (!patched.includes('<base')) {
    throw new Error('could not find a <head> to anchor the editor’s asset paths');
  }

  return URL.createObjectURL(new Blob([patched], { type: 'text/html' }));
}

/**
 * Makes the re-hosted editor behave as an embedded controller.
 *
 * The editor decides this from its URL — `ue.parseQueryString(location.href)`
 * — and a blob URL has no query string, so `?controller=1&ws=iframe` is lost
 * when the page is re-hosted. Chrome refuses `history.replaceState` on a blob
 * URL, so the query cannot be put back either.
 *
 * What it settles with that query is one branch:
 *
 *     g.ws ? setupWorkspace(g.ws) : f ? setupWorkspace("iframe") : ...
 *
 * where `f` is `pxt.shell.isControllerMode()`. Answering that question
 * directly reaches the same branch without needing the URL at all — the editor
 * takes its workspace from the host, which is the whole point of the mode.
 *
 * `pxt` appears partway through startup, so this watches for it rather than
 * assuming it is there, and stops as soon as it has patched.
 */
function controllerShim(): string {
  return `<script>(function () {
  var started = Date.now();

  // Catch the workspace as it is created. MakeCode bundles Blockly as a webpack
  // module, so the global object does not answer getMainWorkspace and there is
  // no registry to ask afterwards — but whatever creates the canvas has to call
  // inject, and wrapping that captures the workspace it returns.
  var injectTimer = setInterval(function () {
    var B = window.Blockly;
    if (B && B.inject && !B.__arcadeWrapped) {
      try {
        var nativeInject = B.inject;
        B.inject = function () {
          var workspace = nativeInject.apply(this, arguments);
          try {
            window.__arcadeWorkspace = workspace;
            // Keep the namespace that was actually called, not the one guessed
            // at from outside: its Xml helpers are needed to drive the
            // workspace, and the global may be a different object.
            window.__arcadeBlockly = this || B;
          } catch (e) {}
          return workspace;
        };
        B.__arcadeWrapped = true;
      } catch (e) {}
      clearInterval(injectTimer);
    } else if (Date.now() - started > 15000) {
      clearInterval(injectTimer);
    }
  }, 2);

  var timer = setInterval(function () {
    var shell = window.pxt && window.pxt.shell;
    if (shell) {
      try {
        shell.isControllerMode = function () { return true; };
        shell.isSandboxMode = function () { return false; };
        shell.isReadOnly = function () { return false; };
      } catch (e) {}
      clearInterval(timer);
    } else if (Date.now() - started > 15000) {
      clearInterval(timer);
    }
  }, 2);
}());</script>`;
}

/**
 * Lets the editor start its workers.
 *
 * Its worker scripts now live on another origin, and browsers refuse to
 * construct a Worker from a cross-origin URL. Being same-origin is what makes
 * the fix possible: this runs inside the editor's own document, ahead of its
 * bundle, and wraps `Worker` so such a URL is fetched and re-hosted as a blob —
 * the same manoeuvre used on the page itself, one level down.
 *
 * `importScripts` inside the worker still resolves against the original origin,
 * which is why the shim gives the wrapper an explicit base.
 */
const WORKER_SHIM = `<script>(function () {
  var Native = window.Worker;
  if (!Native) { return; }
  window.Worker = function (url, options) {
    var href = new URL(url, document.baseURI).href;
    if (new URL(href).origin === location.origin) {
      return new Native(url, options);
    }
    var wrapper = 'importScripts(' + JSON.stringify(href) + ');';
    var blob = new Blob([wrapper], { type: 'application/javascript' });
    return new Native(URL.createObjectURL(blob), options);
  };
  window.Worker.prototype = Native.prototype;
}());</script>`;

/**
 * The Blockly namespace that actually built the editor.
 *
 * Prefers the one captured when `inject` was called, since MakeCode's Blockly
 * is a bundled module and the global may be a different object lacking the Xml
 * helpers needed to drive a workspace.
 */
function blocklyOf(view: any): any {
  return view.__arcadeBlockly ?? view.Blockly;
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
      : `same-origin, no workspace — ${describeEditorState(view)}`,
  };
}

/**
 * Finds the editor's main Blockly workspace, however it is exposed.
 *
 * MakeCode bundles Blockly as a webpack module, so the global `Blockly` is not
 * necessarily the instance that created the editor's workspace. Several routes
 * are tried rather than assuming which one holds it.
 */
function findWorkspace(view: any): any {
  const candidates: Array<() => any> = [
    // Captured by the shim as the editor injected it; the reliable route, since
    // MakeCode's Blockly is a bundled module with no global registry to query.
    () => view.__arcadeWorkspace,
    () => view.Blockly?.getMainWorkspace?.(),
    () => view.Blockly?.common?.getMainWorkspace?.(),
    () => view.Blockly?.common?.getAllWorkspaces?.()?.[0],
    () => view.Blockly?.Workspace?.getAll?.()?.[0],
    () => view.pxt?.blocks?.getMainWorkspace?.(),
    () => view.pxtblockly?.getMainWorkspace?.(),
    () => view.pxt?.editor?.mainWorkspace,
  ];

  for (const candidate of candidates) {
    try {
      const workspace = candidate();
      // A workspace that can be serialized is one we can actually drive.
      if (workspace?.getAllBlocks) {
        return workspace;
      }
    } catch {
      // Try the next route.
    }
  }
  return undefined;
}

/**
 * Describes what the editor's document looks like from here.
 *
 * Reported on screen when no workspace is found, because the useful facts are
 * ones only a real editor can reveal: whether the query string survived being
 * re-hosted, whether the editor actually built a Blockly canvas, and which
 * access routes exist.
 */
function describeEditorState(view: any): string {
  const facts: string[] = [];

  try {
    facts.push(`search=${view.location?.search || '(none)'}`);
  } catch {
    facts.push('search=unreadable');
  }

  try {
    facts.push(`canvas=${view.document.querySelectorAll('.injectionDiv').length}`);
    facts.push(`blocks=${view.document.querySelectorAll('.blocklyDraggable').length}`);
  } catch {
    facts.push('canvas=unreadable');
  }

  try {
    // Which of Blockly's exports are actually present says which build it is.
    const keys = Object.keys(view.Blockly ?? {});
    facts.push(`blocklyKeys=${keys.length}:${keys.slice(0, 8).join(',') || 'none'}`);
    facts.push(`xml=${Boolean(blocklyOf(view)?.Xml)}`);
    facts.push(`editorKeys=${Object.keys(view.pxt?.editor ?? {}).slice(0, 8).join(',') || 'none'}`);
  } catch {
    facts.push('keys=unreadable');
  }

  const routes = [
    ['captured', () => view.__arcadeWorkspace],
    ['Blockly.inject', () => view.Blockly?.inject],
    ['Blockly.getMainWorkspace', () => view.Blockly?.getMainWorkspace],
    ['Blockly.common', () => view.Blockly?.common?.getMainWorkspace],
    ['Workspace.getAll', () => view.Blockly?.Workspace?.getAll],
    ['pxt.blocks', () => view.pxt?.blocks?.getMainWorkspace],
    ['pxt.editor', () => view.pxt?.editor],
  ]
    .filter(([, get]) => {
      try {
        return Boolean((get as () => unknown)());
      } catch {
        return false;
      }
    })
    .map(([name]) => name as string);
  facts.push(`routes=${routes.join('/') || 'none'}`);

  return facts.join(' ');
}

/**
 * True while the user has a block in hand.
 *
 * Nothing may be applied mid-drag: disposing and rebuilding the block someone
 * is dragging takes it out of their hand and strands the gesture.
 */
export function isWorkspaceBusy(reach: EditorReach): boolean {
  try {
    return Boolean(reach.workspace?.isDragging?.());
  } catch {
    return false;
  }
}

/**
 * Applies block XML into the editor's workspace, touching only what changed.
 *
 * This is the whole point of being same-origin, and the reason it is worth the
 * trouble: `importproject` rebuilds the editor, and even
 * `clearWorkspaceAndLoadFromXml` throws away every block and builds them all
 * again — the flash collaborators read as the editor reloading, with selection,
 * undo history and the block under the cursor going with it.
 *
 * Top-level blocks carry stable ids, so the incoming XML can be matched against
 * what is already on the canvas: blocks that did not change are left alone,
 * blocks that did are replaced individually, and blocks that are gone are
 * removed. In the usual case — someone moved one block — exactly one block is
 * rebuilt and the rest of the canvas never flickers.
 *
 * Falls back to a wholesale load only when the XML cannot be matched up at all.
 */
export function applyBlocksDirectly(reach: EditorReach, view: any, xml: string): boolean {
  const workspace = reach.workspace;
  const Blockly = blocklyOf(view);
  if (!workspace || !Blockly?.Xml) {
    return false;
  }

  try {
    const dom = Blockly.utils.xml.textToDom(xml);
    const scroll = { x: workspace.scrollX, y: workspace.scrollY, scale: workspace.scale };

    // Events stay off throughout: each disposal and rebuild would otherwise be
    // reported as the user's own edit and sent straight back out.
    Blockly.Events.disable();
    let merged = false;
    try {
      merged = mergeIntoWorkspace(Blockly, workspace, dom);
      if (!merged) {
        Blockly.Xml.clearWorkspaceAndLoadFromXml(dom, workspace);
      }
    } finally {
      Blockly.Events.enable();
    }

    if (!merged) {
      // Only the wholesale path loses the viewport; a merge never moves it.
      workspace.setScale?.(scroll.scale);
      workspace.scroll?.(scroll.x, scroll.y);
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Reconciles the workspace with incoming XML block by block.
 *
 * Matching happens twice, because ids cannot be relied on: MakeCode saves real
 * Arcade projects with no `id` on the top-level block at all, while Blockly
 * always gives the blocks on its canvas one. Ids are used where both sides have
 * them; everything left over is matched on content, so a block that merely
 * lacks an id is recognized as itself rather than torn down and rebuilt.
 *
 * Returns false only if nothing in the XML could be read as blocks, which means
 * a wholesale load is the only correct answer.
 *
 * Exported so the matching can be tested against real Arcade files, where
 * getting it wrong means rebuilding a canvas that did not change.
 */
export function mergeIntoWorkspace(Blockly: any, workspace: any, dom: Element): boolean {
  const incoming: Element[] = [];
  let variables: Element | undefined;

  for (const child of Array.from(dom.children)) {
    const tag = child.tagName.toLowerCase();
    if (tag === 'variables') {
      variables = child;
    } else if (tag === 'block' || tag === 'shadow') {
      incoming.push(child);
    }
  }
  if (!incoming.length && workspace.getTopBlocks(false).length) {
    // An empty document against a full canvas is not a merge worth guessing at.
    return false;
  }

  // Variables first: a block referring to one created elsewhere cannot be built
  // until the workspace knows about it.
  if (variables) {
    Blockly.Xml.domToVariables(variables, workspace);
  }

  const unmatched = new Map<string, any>();
  for (const block of workspace.getTopBlocks(false)) {
    unmatched.set(block.id, block);
  }

  /** Incoming elements still needing a home, and the block each one replaces. */
  const rebuild: Element[] = [];

  // Pass one: ids, where the incoming XML has them.
  const byContent: Element[] = [];
  for (const element of incoming) {
    const id = element.getAttribute('id');
    const current = id ? unmatched.get(id) : undefined;
    if (!current) {
      byContent.push(element);
      continue;
    }
    unmatched.delete(current.id);
    if (canonicalize(Blockly.Xml.blockToDom(current)) !== canonicalize(element)) {
      current.dispose(false);
      rebuild.push(element);
    }
    // Otherwise unchanged: leaving it alone is what keeps the canvas still.
  }

  // Pass two: content, for incoming blocks with no id or an id the canvas does
  // not know. An exact content match is the same block by another name.
  const remaining = new Map<string, any[]>();
  for (const block of unmatched.values()) {
    const key = canonicalize(Blockly.Xml.blockToDom(block), true);
    const bucket = remaining.get(key);
    if (bucket) {
      bucket.push(block);
    } else {
      remaining.set(key, [block]);
    }
  }

  for (const element of byContent) {
    const bucket = remaining.get(canonicalize(element, true));
    const match = bucket?.shift();
    if (match) {
      unmatched.delete(match.id);
    } else {
      rebuild.push(element);
    }
  }

  // Whatever the incoming XML never claimed has been deleted elsewhere.
  for (const block of unmatched.values()) {
    block.dispose(false);
  }

  for (const element of rebuild) {
    Blockly.Xml.domToBlock(element, workspace);
  }

  return true;
}

/**
 * A comparable form of a block's XML.
 *
 * The file's XML and Blockly's own serialization of the same block agree on
 * meaning but not on spelling — attribute order differs, whitespace differs,
 * coordinates carry fractions. Comparing the text directly would call every
 * block changed and rebuild the whole canvas, which is exactly what this is
 * here to avoid.
 *
 * `ignoreId` drops the id, for comparing a block against an incoming element
 * that carries none.
 */
function canonicalize(element: Element, ignoreId = false): string {
  const attributes = Array.from(element.attributes)
    .filter((attribute) => !(ignoreId && attribute.name === 'id'))
    .map((attribute) => {
      const value =
        attribute.name === 'x' || attribute.name === 'y'
          ? String(Math.round(Number(attribute.value) || 0))
          : attribute.value;
      return `${attribute.name}=${value}`;
    })
    .sort()
    .join(' ');

  const children = Array.from(element.childNodes)
    .map((node) => {
      if (node.nodeType === 1) {
        return canonicalize(node as Element, ignoreId);
      }
      if (node.nodeType === 3) {
        const text = (node.textContent ?? '').trim();
        return text ? `#${text}` : '';
      }
      return '';
    })
    .filter(Boolean)
    .join('');

  return `<${element.tagName.toLowerCase()} ${attributes}>${children}`;
}

/** Reads the editor's current blocks without waiting for it to save. */
export function readBlocksDirectly(reach: EditorReach, view: any): string | undefined {
  const workspace = reach.workspace;
  const Blockly = blocklyOf(view);
  if (!workspace || !Blockly?.Xml) {
    return undefined;
  }
  try {
    return Blockly.Xml.domToText(Blockly.Xml.workspaceToDom(workspace));
  } catch {
    return undefined;
  }
}
