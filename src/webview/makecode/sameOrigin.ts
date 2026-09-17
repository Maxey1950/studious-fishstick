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
export async function createBlobEditorUrl(requireCorp: boolean): Promise<string> {
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
  // the editor. Where the webview is a require-corp document — vscode.dev — this
  // blob inherits that policy, under which a cross-origin frame must assert COEP
  // itself; MakeCode's simulator origin does not, so the frame is refused and
  // the simulator never appears. `credentialless` is the same escape hatch used
  // for the editor itself, applied one level down.
  //
  // Only where it is needed, though. A credentialless frame is loaded without
  // credentials and into an ephemeral storage partition, and the simulator
  // registers a service worker — so applying it in desktop VS Code, which sets
  // no such policy, takes the simulator away to solve a problem that is not
  // there.
  const framed = requireCorp
    ? absolute.replace(/<iframe(\s)/gi, '<iframe credentialless$1')
    : absolute;

  const patched = framed.replace(
    /<head([^>]*)>/i,
    `<head$1><base href="${origin}/">${controllerShim()}${SAVE_SHIM}${requireCorp ? FRAME_SHIM : ''}${WORKER_SHIM}`
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
  //
  // In the shipped build the real Blockly never reaches the window at all: what
  // is there is a stub carrying only Msg. So this is a best effort, and the
  // route below is the one that works.
  var injectTimer = setInterval(function () {
    var B = window.Blockly;
    if (B && B.inject && !B.__arcadeWrapped) {
      try {
        var nativeInject = B.inject;
        B.inject = function () {
          var workspace = nativeInject.apply(this, arguments);
          try {
            window.__arcadeWorkspace = workspace;
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

  // The route that actually reaches the editor.
  //
  // pxt.editor.initExtensionsAsync is a hook the target fills in and the editor
  // calls once during startup, handing it the running ProjectView. That object
  // owns the blocks editor, and the blocks editor owns the live Blockly
  // workspace — so watching the hook being called gets us both, though neither
  // is ever a global.
  //
  // Wrapping it once is not enough: the target assigns its own function onto
  // pxt.editor during startup, which replaces any wrapper already sitting
  // there. So the property itself is redefined — every assignment is caught and
  // re-wrapped, and whatever the target sets is still what runs.
  function watchHook(host, name) {
    var native = host[name];
    if (host['__arcade_' + name]) { return; }
    var wrap = function (fn) {
      if (typeof fn !== 'function' || fn.__arcadeWrapped) { return fn; }
      var wrapped = function (opts) {
        try { window.__arcadeOpts = opts; } catch (e) {}
        return fn.apply(this, arguments);
      };
      wrapped.__arcadeWrapped = true;
      return wrapped;
    };
    var current = wrap(native);
    try {
      Object.defineProperty(host, name, {
        configurable: true,
        enumerable: true,
        get: function () { return current; },
        set: function (value) { current = wrap(value); }
      });
      host['__arcade_' + name] = true;
    } catch (e) {}
  }

  var editorTimer = setInterval(function () {
    var editor = window.pxt && window.pxt.editor;
    if (!editor) {
      if (Date.now() - started > 15000) { clearInterval(editorTimer); }
      return;
    }
    watchHook(editor, 'initExtensionsAsync');
    watchHook(editor, 'initFieldExtensionsAsync');
    clearInterval(editorTimer);
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
 * Gives Ctrl+S back to VS Code.
 *
 * MakeCode binds Ctrl+S to its own save, and a keystroke inside a nested frame
 * never reaches the document above it — so VS Code never saw it, the file kept
 * its dirty dot, and the only way to save was to close the tab and answer the
 * prompt. Being same-origin means the editor's own key handling can be headed
 * off and the keystroke passed up to where it belongs.
 *
 * Capture phase, so this runs before the editor's own handler rather than after
 * it has already swallowed the event.
 */
const SAVE_SHIM = `<script>(function () {
  window.addEventListener('keydown', function (event) {
    var save = (event.ctrlKey || event.metaKey) && !event.altKey &&
      (event.key === 's' || event.key === 'S');
    if (!save) { return; }
    event.preventDefault();
    event.stopPropagation();
    try { parent.postMessage({ type: 'blocksEditorSave' }, '*'); } catch (e) {}
  }, true);
}());</script>`;

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
  if (view.__arcadeNamespace?.Xml) {
    return view.__arcadeNamespace;
  }
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

  // Nothing named it, so go looking. In the shipped build the window's Blockly
  // is a stub carrying only Msg — the real one is a bundled module — but the
  // object graph the editor handed its extension hook reaches the live editor,
  // and something in there holds the namespace that built the workspace.
  const found = findBlockly(view);
  if (found) {
    try {
      view.__arcadeNamespace = found;
    } catch {
      // Not being able to cache it only costs another search.
    }
    return found;
  }
  return candidate;
}

/** The real Blockly namespace: the one that can parse and build blocks. */
function isBlockly(value: any): boolean {
  try {
    return Boolean(
      value &&
        value.Xml &&
        typeof value.Xml.domToText === 'function' &&
        typeof value.Xml.domToBlock === 'function' &&
        value.Events &&
        typeof value.Events.disable === 'function'
    );
  } catch {
    return false;
  }
}

/** Looks for the Blockly namespace anywhere the editor's own objects reach. */
function findBlockly(view: any): any {
  const test = (value: any): any => (isBlockly(value) ? value : undefined);
  const seen = new Set<any>();
  const guarded = (value: any): any => {
    if (!value || seen.has(value)) {
      return undefined;
    }
    seen.add(value);
    return test(value);
  };

  for (const root of [view.__arcadeOpts, view.pxt, view.pxtblockly, view.pxtblocks]) {
    const found = descend(root, 4, guarded);
    if (found) {
      return found;
    }
  }
  return undefined;
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
    // Through the ProjectView the editor handed to its own extension hook.
    () => view.__arcadeOpts?.projectView?.blocksEditor?.editor,
    () => view.__arcadeOpts?.projectView?.editor?.editor,
    () => view.__arcadeOpts?.projectView?.blocksEditor?.workspace,
    // Through React, which owns the canvas whether or not any pxt hook fired.
    () => findWorkspaceViaReact(view),
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

/**
 * A workspace is whatever can list its blocks and be driven.
 *
 * Every property read here is guarded, because the editor's own window carries
 * its child frames as properties — the simulator among them — and reading any
 * property of a cross-origin frame throws a SecurityError rather than returning
 * undefined.
 */
function isWorkspace(value: any): boolean {
  try {
    return Boolean(
      value &&
        typeof value.getAllBlocks === 'function' &&
        typeof value.getTopBlocks === 'function' &&
        typeof value.newBlock === 'function'
    );
  } catch {
    return false;
  }
}

/** True for a Window, which is never a workspace and may throw when read. */
function isFrame(value: any): boolean {
  try {
    return Boolean(value) && typeof value === 'object' && value.window === value;
  } catch {
    // Only a cross-origin Window throws on that read, so that is what it is.
    return true;
  }
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
    if (!value || seen.has(value) || isFrame(value)) {
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

  // The captured options first: the workspace is in there, several layers down,
  // and nothing else on the window holds it at all.
  const deep = descend(view.__arcadeOpts, 4, test);
  if (deep) {
    return deep;
  }

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
    if (isFrame(value)) {
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
 * Finds the workspace through the React tree that rendered the canvas.
 *
 * Independent of anything pxt chooses to expose. The editor is a React
 * application, and React leaves a reference to its internal fiber on the DOM
 * nodes it creates. The canvas is rendered by the component that owns the
 * workspace, so walking up from the canvas to the component instances that
 * contain it reaches the object holding it — no global, no hook, no cooperation
 * from the editor at all.
 */
function findWorkspaceViaReact(view: any): any {
  let node: any;
  try {
    node =
      view.document.querySelector('.injectionDiv') ??
      view.document.querySelector('.blocklyWorkspace') ??
      view.document.querySelector('.blocklySvg');
  } catch {
    return undefined;
  }
  if (!node) {
    return undefined;
  }

  let fiber: any;
  try {
    const key = Object.keys(node).find(
      (name) => name.startsWith('__reactFiber$') || name.startsWith('__reactInternalInstance$')
    );
    fiber = key ? node[key] : undefined;
  } catch {
    return undefined;
  }

  // Upwards through the owning components. Bounded: the tree above the canvas
  // is shallow, and an unbounded walk on a cyclic structure does not end.
  for (let depth = 0; fiber && depth < 40; depth++) {
    const instance = fiber.stateNode;
    for (const name of ['editor', 'workspace', 'mainWorkspace']) {
      try {
        if (isWorkspace(instance?.[name])) {
          return instance[name];
        }
      } catch {
        // Keep climbing.
      }
    }
    if (isWorkspace(instance)) {
      return instance;
    }
    try {
      fiber = fiber.return;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * Walks an object looking for a workspace, to a bounded depth.
 *
 * Bounded because this runs while the editor is starting and the object graph
 * it is handed loops back on itself in several places.
 */
function descend(value: any, depth: number, test: (value: any) => any): any {
  if (!value || depth < 0 || isFrame(value)) {
    return undefined;
  }
  const found = test(value);
  if (found) {
    return found;
  }
  if (depth === 0) {
    return undefined;
  }

  let keys: string[];
  try {
    keys = Object.keys(value);
  } catch {
    return undefined;
  }
  for (const key of keys) {
    let child: any;
    try {
      child = value[key];
    } catch {
      continue;
    }
    if (!child || (typeof child !== 'object' && typeof child !== 'function')) {
      continue;
    }
    const inside = descend(child, depth - 1, test);
    if (inside) {
      return inside;
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

  // What the editor handed its own extension hook, which is the one object
  // graph that reaches the live editor. If the workspace is not in here, it is
  // not anywhere this code can get to.
  try {
    const opts = view.__arcadeOpts;
    facts.push(`opts=${opts ? Object.keys(opts).slice(0, 8).join(',') || 'empty' : 'none'}`);
    const projectView = opts?.projectView;
    facts.push(
      `projectView=${projectView ? Object.keys(projectView).slice(0, 12).join(',') : 'none'}`
    );
    const blocksEditor = projectView?.blocksEditor;
    facts.push(
      `blocksEditor=${blocksEditor ? Object.keys(blocksEditor).slice(0, 12).join(',') : 'none'}`
    );
    facts.push(`namespace=${Boolean(findBlockly(view))}`);
    facts.push(`react=${Boolean(findWorkspaceViaReact(view))}`);
    facts.push(`pxt=${Object.keys(view.pxt ?? {}).slice(0, 14).join(',') || 'none'}`);
    facts.push(
      `pxtBlocks=${Object.keys(view.pxt?.blocks ?? {}).slice(0, 14).join(',') || 'none'}`
    );
  } catch {
    facts.push('opts=unreadable');
  }

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
