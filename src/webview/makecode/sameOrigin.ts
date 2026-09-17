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

/**
 * How a peer's change reached the editor.
 *
 * `merge` touched only the blocks that changed; `canvas` rebuilt the blocks but
 * left the editor standing; `import` is the last resort that reloads everything.
 */
export interface ApplyResult {
  mode: 'merge' | 'canvas' | 'import';
  detail: string;
}

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
  // The simulator lives in a cross-origin iframe of its own, one level inside
  // the editor. On vscode.dev the webview is a require-corp document and this
  // blob inherits that policy, under which a cross-origin frame must assert
  // COEP itself — MakeCode's simulator origin does not, so the frame would be
  // refused and the simulator would simply not appear. `credentialless` is the
  // same escape hatch used for the editor itself, applied one level down.
  const framed = absolute.replace(/<iframe(\s)/gi, '<iframe credentialless$1');

  const patched = framed.replace(
    /<head([^>]*)>/i,
    `<head$1><base href="${origin}/">${controllerShim()}${FRAME_SHIM}${WORKER_SHIM}`
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
 * Makes the frames the editor creates embeddable under a require-corp document.
 *
 * The simulator's frame is built at runtime rather than served in the page, so
 * rewriting the fetched HTML does not reach it. `credentialless` has to be set
 * before the frame enters the document — afterwards its load has already begun
 * — so this marks them as they are created.
 */
const FRAME_SHIM = `<script>(function () {
  var create = document.createElement.bind(document);
  document.createElement = function (tag) {
    var element = create.apply(null, arguments);
    try {
      if (String(tag).toLowerCase() === 'iframe') {
        element.credentialless = true;
      }
    } catch (e) {}
    return element;
  };
}());</script>`;

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
function blocklyOf(view: any, workspace?: any): any {
  const candidate = view.__arcadeBlockly ?? view.Blockly;
  if (candidate?.Xml) {
    return candidate;
  }
  // The window need not carry Blockly at all. The workspace itself was built by
  // it, so its own options and constructor lead back to the namespace that made
  // it — which is the one whose Xml helpers will actually drive it.
  for (const route of [
    () => workspace?.options?.Blockly,
    () => workspace?.Blockly,
    () => workspace?.constructor?.Blockly,
  ]) {
    try {
      const found = route();
      if (found?.Xml) {
        return found;
      }
    } catch {
      // Try the next.
    }
  }
  return candidate;
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
      if (isWorkspace(workspace)) {
        return workspace;
      }
    } catch {
      // Try the next route.
    }
  }

  // None of the known names held it. MakeCode's build need not put Blockly on
  // the window at all — in the build this runs against it does not — so rather
  // than guessing at another name, look for an object that behaves like a
  // workspace.
  return scanForWorkspace(view);
}

/** A workspace is whatever can list its blocks and be driven. */
function isWorkspace(value: any): boolean {
  return Boolean(
    value &&
      typeof value.getAllBlocks === 'function' &&
      typeof value.getTopBlocks === 'function' &&
      typeof value.newBlock === 'function'
  );
}

/**
 * Looks through the editor's globals for its workspace.
 *
 * Deliberately shallow — two levels, and only into objects the editor put on
 * its own window — because this runs on a timer while the editor starts up.
 */
function scanForWorkspace(view: any): any {
  const seen = new Set<any>();

  const test = (value: any): any => {
    if (!value || seen.has(value)) {
      return undefined;
    }
    seen.add(value);
    if (isWorkspace(value)) {
      return value;
    }
    for (const name of ['mainWorkspace', 'workspace', 'ws']) {
      try {
        if (isWorkspace(value[name])) {
          return value[name];
        }
      } catch {
        // Some properties throw on access; they are not it.
      }
    }
    for (const name of ['getMainWorkspace', 'getWorkspace']) {
      try {
        const found = typeof value[name] === 'function' ? value[name]() : undefined;
        if (isWorkspace(found)) {
          return found;
        }
      } catch {
        // Likewise.
      }
    }
    return undefined;
  };

  let names: string[];
  try {
    names = Object.getOwnPropertyNames(view);
  } catch {
    return undefined;
  }

  for (const name of names) {
    let value: any;
    try {
      value = view[name];
    } catch {
      continue;
    }
    if (!value || (typeof value !== 'object' && typeof value !== 'function')) {
      continue;
    }

    const direct = test(value);
    if (direct) {
      return direct;
    }

    // One level in, for namespaces like `pxt` that hold the editor's pieces.
    let inner: string[];
    try {
      inner = Object.keys(value);
    } catch {
      continue;
    }
    for (const key of inner) {
      let child: any;
      try {
        child = value[key];
      } catch {
        continue;
      }
      if (!child || (typeof child !== 'object' && typeof child !== 'function')) {
        continue;
      }
      const found = test(child);
      if (found) {
        return found;
      }
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
    facts.push(`Blockly=${typeof view.Blockly} xml=${Boolean(blocklyOf(view)?.Xml)}`);
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
 * Falls back to a wholesale canvas load when the XML cannot be matched up, and
 * reports which route it took so a reload is never a mystery.
 */
export function applyBlocksDirectly(reach: EditorReach, view: any, xml: string): ApplyResult {
  const workspace = reach.workspace;
  const Blockly = blocklyOf(view, workspace);
  if (!workspace || !Blockly?.Xml) {
    return { mode: 'import', detail: workspace ? 'no Blockly.Xml' : 'no workspace' };
  }

  let dom: Element;
  try {
    dom = Blockly.utils.xml.textToDom(xml);
  } catch (error) {
    return { mode: 'import', detail: `unparseable XML: ${describe(error)}` };
  }

  // Events stay off throughout: each disposal and rebuild would otherwise be
  // reported as the user's own edit and sent straight back out.
  Blockly.Events.disable();
  let merged: string | undefined;
  try {
    merged = mergeIntoWorkspace(Blockly, workspace, dom);
  } catch (error) {
    merged = `merge threw: ${describe(error)}`;
  } finally {
    Blockly.Events.enable();
  }

  if (merged === undefined) {
    return { mode: 'merge', detail: 'changed blocks only' };
  }

  // The merge could not be trusted, but the workspace is still right here: a
  // wholesale load rebuilds the canvas, which flashes, and is still enormously
  // better than importproject tearing down the editor and the simulator with
  // it. Reaching for a reload because a merge went wrong would give up the
  // whole reason for loading same-origin.
  const scroll = { x: workspace.scrollX, y: workspace.scrollY, scale: workspace.scale };
  Blockly.Events.disable();
  try {
    Blockly.Xml.clearWorkspaceAndLoadFromXml(dom, workspace);
  } catch (error) {
    return { mode: 'import', detail: `reload threw: ${describe(error)}` };
  } finally {
    Blockly.Events.enable();
  }
  workspace.setScale?.(scroll.scale);
  workspace.scroll?.(scroll.x, scroll.y);
  return { mode: 'canvas', detail: merged };
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
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
 * Returns undefined when it merged, or the reason it would not — the caller
 * turns that into a wholesale canvas load.
 *
 * Exported so the matching can be tested against real Arcade files, where
 * getting it wrong means rebuilding a canvas that did not change.
 */
export function mergeIntoWorkspace(
  Blockly: any,
  workspace: any,
  dom: Element
): string | undefined {
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
    return 'incoming XML has no blocks';
  }

  // Variables first: a block referring to one created elsewhere cannot be built
  // until the workspace knows about it. Guarded on its own, because every real
  // Arcade file has a <variables> block and pxt's bundled Blockly need not
  // spell this helper the way the standalone one does — letting it throw here
  // would have failed the whole merge on exactly the files that matter.
  if (variables) {
    try {
      Blockly.Xml.domToVariables(variables, workspace);
    } catch {
      // Blocks carry their variable's id and name inline, so this is survivable.
    }
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

  return undefined;
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
  const Blockly = blocklyOf(view, workspace);
  if (!workspace || !Blockly?.Xml) {
    return undefined;
  }
  try {
    return Blockly.Xml.domToText(Blockly.Xml.workspaceToDom(workspace));
  } catch {
    return undefined;
  }
}
