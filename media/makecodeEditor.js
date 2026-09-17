"use strict";
(() => {
  // src/shared/projectFiles.ts
  var SHARED_FILES = [
    "pxt.json",
    "assets.json",
    "main.ts",
    // Generated from assets.json, but real files in a project on disk, and
    // declared in pxt.json — which makes them the compiler's business. A project
    // that lists a file it does not have fails to build at all.
    "images.g.ts",
    "tilemap.g.ts"
  ];
  function isShared(name) {
    return SHARED_FILES.includes(name);
  }
  function sharedFiles(text) {
    const files = {};
    for (const name of SHARED_FILES) {
      const content = text[name];
      if (typeof content === "string") {
        files[name] = content;
      }
    }
    return files;
  }
  function changedFiles(previous, next) {
    const changed = {};
    for (const [name, content] of Object.entries(next)) {
      if (!isShared(name)) {
        continue;
      }
      const before = previous[name];
      if (content === before || isEmpty(content)) {
        continue;
      }
      changed[name] = content;
    }
    return changed;
  }
  function isEmpty(content) {
    return content === void 0 || content.trim() === "";
  }
  function withFiles(project2, files) {
    const text = { ...project2.text };
    for (const [name, content] of Object.entries(files)) {
      if (isShared(name)) {
        text[name] = content;
      }
    }
    return { ...project2, text };
  }
  function withDeclaredStubs(project2) {
    const config = project2.text["pxt.json"];
    if (config === void 0) {
      return project2;
    }
    let declared;
    try {
      declared = JSON.parse(config).files;
    } catch {
      return project2;
    }
    if (!Array.isArray(declared)) {
      return project2;
    }
    const text = { ...project2.text };
    let added = false;
    for (const entry of declared) {
      const name = String(entry);
      if (text[name] === void 0) {
        text[name] = "";
        added = true;
      }
    }
    return added ? { ...project2, text } : project2;
  }

  // src/shared/arcadeProtocol.ts
  var ARCADE_EDITOR_URL = "https://arcade.makecode.com/?controller=1&ws=iframe&nocookiebanner=1";
  function hasNoBlocks(xml) {
    return !/<block\b/i.test(xml);
  }
  function handleEditorMessage(message, project2) {
    if (!message || typeof message !== "object" || message.type !== "pxthost") {
      return { kind: "ignore" };
    }
    switch (message.action) {
      case "workspacesync":
        return {
          kind: "reply",
          message: {
            type: "pxthost",
            id: message.id,
            success: true,
            // Every file the project declares has to be there, or it does not
            // build and there is nothing to run.
            projects: [withDeclaredStubs(project2)]
          }
        };
      case "newproject":
        return {
          kind: "reply",
          message: {
            type: "pxthost",
            id: message.id,
            success: true,
            // Every file the project declares has to be there, or it does not
            // build and there is nothing to run.
            projects: [withDeclaredStubs(project2)]
          }
        };
      case "workspacereset":
        return { kind: "reply", message: { type: "pxthost", id: message.id, success: true } };
      case "workspacesave": {
        if (!message.project?.text) {
          return { kind: "ignore" };
        }
        return { kind: "projectChanged", project: message.project };
      }
      case "workspaceloaded":
      case "editorcontentloaded":
        return { kind: "status", status: "ready" };
      default:
        return { kind: "ignore" };
    }
  }
  function importProjectMessage(project2) {
    return { type: "pxteditor", action: "importproject", project: withDeclaredStubs(project2) };
  }
  function editorCommand(action) {
    return { type: "pxteditor", action };
  }
  function createProject(name, blocks) {
    return {
      header: {
        name,
        id: `collab-${name}`,
        editor: "blocksprj",
        pubId: "",
        pubCurrent: false,
        target: "arcade",
        recentUse: Date.now(),
        modificationTime: Date.now(),
        path: name,
        cloudUserId: null,
        cloudCurrent: false,
        cloudVersion: null,
        cloudLastSyncTime: 0,
        isDeleted: false
      },
      text: {
        "main.blocks": blocks,
        // MakeCode regenerates main.ts from the blocks; a placeholder is enough.
        "main.ts": " ",
        "pxt.json": JSON.stringify(
          {
            name,
            description: "",
            dependencies: { device: "*" },
            files: ["main.blocks", "main.ts"]
          },
          null,
          2
        )
      }
    };
  }
  function blocksOf(project2) {
    return project2.text["main.blocks"] ?? "";
  }
  function withBlocks(project2, blocks) {
    return {
      header: project2.header,
      text: { ...project2.text, "main.blocks": blocks }
    };
  }

  // src/shared/sameBlocks.ts
  function sameBlocks(a, b) {
    if (a === b) {
      return true;
    }
    const left = canonicalXml(a);
    const right = canonicalXml(b);
    return left !== void 0 && left === right;
  }
  function canonicalXml(xml) {
    try {
      const doc = new DOMParser().parseFromString(xml, "text/xml");
      if (doc.getElementsByTagName("parsererror").length) {
        return void 0;
      }
      return canonicalElement(doc.documentElement);
    } catch {
      return void 0;
    }
  }
  function canonicalElement(element) {
    const attributes = Array.from(element.attributes).map((attribute) => {
      const value = attribute.name === "x" || attribute.name === "y" ? String(Math.round(Number(attribute.value) || 0)) : attribute.value;
      return `${attribute.name}=${value}`;
    }).sort().join(" ");
    const children = Array.from(element.childNodes).map((node) => {
      if (node.nodeType === 1) {
        return canonicalElement(node);
      }
      if (node.nodeType === 3) {
        const text = (node.textContent ?? "").replace(/^\s+|\s+$/g, "");
        return text ? `#${text}` : "";
      }
      return "";
    }).filter(Boolean).join("");
    return `<${element.tagName.toLowerCase()} ${attributes}>${children}`;
  }

  // src/shared/syncState.ts
  var DEFAULT_SYNC_OPTIONS = {
    sendDebounceMs: 100,
    applyAfterIdleMs: 150
  };
  var SyncState = class {
    constructor(options = DEFAULT_SYNC_OPTIONS) {
      this.options = options;
      this.state = { lastLocalChangeMs: Number.NEGATIVE_INFINITY };
    }
    /** The editor reported a change (a `workspacesave` push). */
    onLocalChange(blocks, nowMs) {
      if (blocks === this.state.appliedRemote) {
        this.state.local = blocks;
        return;
      }
      this.state.local = blocks;
      this.state.lastLocalChangeMs = nowMs;
      this.state.lastLocalUnsentMs = blocks === this.state.sent ? void 0 : nowMs;
      this.state.pendingRemote = void 0;
    }
    /** A peer sent their content. */
    onRemoteChange(blocks, _nowMs) {
      if (blocks === this.state.local) {
        return;
      }
      this.state.pendingRemote = blocks;
    }
    /**
     * Returns what to do now. Call after either event and on a timer.
     *
     * Sending is checked before applying: an unsent local edit is the user's own
     * work and must reach peers even if a remote change is also waiting.
     */
    next(nowMs) {
      const { sendDebounceMs, applyAfterIdleMs } = this.options;
      if (this.state.lastLocalUnsentMs !== void 0 && this.state.local !== void 0) {
        const dueAt = this.state.lastLocalUnsentMs + sendDebounceMs;
        if (nowMs >= dueAt) {
          const blocks = this.state.local;
          this.state.sent = blocks;
          this.state.lastLocalUnsentMs = void 0;
          return { kind: "broadcast", blocks };
        }
        return { kind: "wait", untilMs: dueAt };
      }
      if (this.state.pendingRemote !== void 0) {
        const dueAt = this.state.lastLocalChangeMs + applyAfterIdleMs;
        if (nowMs >= dueAt) {
          const blocks = this.state.pendingRemote;
          this.state.pendingRemote = void 0;
          this.state.appliedRemote = blocks;
          this.state.sent = blocks;
          return { kind: "apply", blocks };
        }
        return { kind: "wait", untilMs: dueAt };
      }
      return void 0;
    }
    /** True while a peer's change is waiting for the user to pause. */
    hasPendingRemote() {
      return this.state.pendingRemote !== void 0;
    }
  };

  // src/webview/makecode/sameOrigin.ts
  async function createBlobEditorUrl(requireCorp) {
    const response = await fetch(ARCADE_EDITOR_URL, { credentials: "omit" });
    if (!response.ok) {
      throw new Error(`MakeCode returned ${response.status}`);
    }
    const html = await response.text();
    const origin = new URL(ARCADE_EDITOR_URL).origin;
    const absolute = html.replace(/"\/---/g, `"${origin}/---`);
    const framed = requireCorp ? absolute.replace(/<iframe(\s)/gi, "<iframe credentialless$1") : absolute;
    const patched = framed.replace(
      /<head([^>]*)>/i,
      `<head$1><base href="${origin}/">${controllerShim()}${SAVE_SHIM}${requireCorp ? FRAME_SHIM : ""}${WORKER_SHIM}`
    );
    if (!patched.includes("<base")) {
      throw new Error("could not find a <head> to anchor the editor\u2019s asset paths");
    }
    return URL.createObjectURL(new Blob([patched], { type: "text/html" }));
  }
  function controllerShim() {
    return `<script>(function () {
  var started = Date.now();

  // Catch the workspace as it is created. MakeCode bundles Blockly as a webpack
  // module, so the global object does not answer getMainWorkspace and there is
  // no registry to ask afterwards \u2014 but whatever creates the canvas has to call
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
}());<\/script>`;
  }
  var SAVE_SHIM = `<script>(function () {
  window.addEventListener('keydown', function (event) {
    var save = (event.ctrlKey || event.metaKey) && !event.altKey &&
      (event.key === 's' || event.key === 'S');
    if (!save) { return; }
    event.preventDefault();
    event.stopPropagation();
    try { parent.postMessage({ type: 'blocksEditorSave' }, '*'); } catch (e) {}
  }, true);
}());<\/script>`;
  var FRAME_SHIM = `<script>(function () {
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
}());<\/script>`;
  var WORKER_SHIM = `<script>(function () {
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
}());<\/script>`;
  function blocklyOf(view, workspace) {
    const candidate = view.__arcadeBlockly ?? view.Blockly;
    if (candidate?.Xml) {
      return candidate;
    }
    for (const route of [
      () => workspace?.options?.Blockly,
      () => workspace?.Blockly,
      () => workspace?.constructor?.Blockly
    ]) {
      try {
        const found = route();
        if (found?.Xml) {
          return found;
        }
      } catch {
      }
    }
    return candidate;
  }
  function probeEditor(frame2) {
    const view = frame2.contentWindow;
    try {
      void view.document.title;
    } catch {
      return {
        sameOrigin: false,
        globals: [],
        detail: "cross-origin: only importproject is available, so changes reload the editor"
      };
    }
    const globals = ["Blockly", "pxt", "pxsim", "pxtblockly"].filter(
      (name) => view[name] !== void 0
    );
    const workspace = findWorkspace(view);
    return {
      sameOrigin: true,
      globals,
      workspace,
      detail: workspace ? `same-origin, workspace reachable (globals: ${globals.join(", ") || "none"})` : `same-origin, no workspace \u2014 ${describeEditorState(view)}`
    };
  }
  function findWorkspace(view) {
    const candidates = [
      // Captured by the shim as the editor injected it; the reliable route, since
      // MakeCode's Blockly is a bundled module with no global registry to query.
      () => view.__arcadeWorkspace,
      () => view.Blockly?.getMainWorkspace?.(),
      () => view.Blockly?.common?.getMainWorkspace?.(),
      () => view.Blockly?.common?.getAllWorkspaces?.()?.[0],
      () => view.Blockly?.Workspace?.getAll?.()?.[0],
      () => view.pxt?.blocks?.getMainWorkspace?.(),
      () => view.pxtblockly?.getMainWorkspace?.(),
      () => view.pxt?.editor?.mainWorkspace
    ];
    for (const candidate of candidates) {
      try {
        const workspace = candidate();
        if (isWorkspace(workspace)) {
          return workspace;
        }
      } catch {
      }
    }
    return scanForWorkspace(view);
  }
  function isWorkspace(value) {
    try {
      return Boolean(
        value && typeof value.getAllBlocks === "function" && typeof value.getTopBlocks === "function" && typeof value.newBlock === "function"
      );
    } catch {
      return false;
    }
  }
  function isFrame(value) {
    try {
      return Boolean(value) && typeof value === "object" && value.window === value;
    } catch {
      return true;
    }
  }
  function scanForWorkspace(view) {
    const seen = /* @__PURE__ */ new Set();
    const test = (value) => {
      if (!value || seen.has(value) || isFrame(value)) {
        return void 0;
      }
      seen.add(value);
      if (isWorkspace(value)) {
        return value;
      }
      for (const name of ["mainWorkspace", "workspace", "ws"]) {
        try {
          if (isWorkspace(value[name])) {
            return value[name];
          }
        } catch {
        }
      }
      for (const name of ["getMainWorkspace", "getWorkspace"]) {
        try {
          const found = typeof value[name] === "function" ? value[name]() : void 0;
          if (isWorkspace(found)) {
            return found;
          }
        } catch {
        }
      }
      return void 0;
    };
    let names;
    try {
      names = Object.getOwnPropertyNames(view);
    } catch {
      return void 0;
    }
    for (const name of names) {
      let value;
      try {
        value = view[name];
      } catch {
        continue;
      }
      if (!value || typeof value !== "object" && typeof value !== "function") {
        continue;
      }
      if (isFrame(value)) {
        continue;
      }
      const direct = test(value);
      if (direct) {
        return direct;
      }
      let inner;
      try {
        inner = Object.keys(value);
      } catch {
        continue;
      }
      for (const key of inner) {
        let child;
        try {
          child = value[key];
        } catch {
          continue;
        }
        if (!child || typeof child !== "object" && typeof child !== "function") {
          continue;
        }
        const found = test(child);
        if (found) {
          return found;
        }
      }
    }
    return void 0;
  }
  function describeEditorState(view) {
    const facts = [];
    try {
      facts.push(`search=${view.location?.search || "(none)"}`);
    } catch {
      facts.push("search=unreadable");
    }
    try {
      facts.push(`canvas=${view.document.querySelectorAll(".injectionDiv").length}`);
      facts.push(`blocks=${view.document.querySelectorAll(".blocklyDraggable").length}`);
    } catch {
      facts.push("canvas=unreadable");
    }
    try {
      const keys = Object.keys(view.Blockly ?? {});
      facts.push(`blocklyKeys=${keys.length}:${keys.slice(0, 8).join(",") || "none"}`);
      facts.push(`Blockly=${typeof view.Blockly} xml=${Boolean(blocklyOf(view)?.Xml)}`);
      facts.push(`editorKeys=${Object.keys(view.pxt?.editor ?? {}).slice(0, 8).join(",") || "none"}`);
    } catch {
      facts.push("keys=unreadable");
    }
    const routes = [
      ["captured", () => view.__arcadeWorkspace],
      ["Blockly.inject", () => view.Blockly?.inject],
      ["Blockly.getMainWorkspace", () => view.Blockly?.getMainWorkspace],
      ["Blockly.common", () => view.Blockly?.common?.getMainWorkspace],
      ["Workspace.getAll", () => view.Blockly?.Workspace?.getAll],
      ["pxt.blocks", () => view.pxt?.blocks?.getMainWorkspace],
      ["pxt.editor", () => view.pxt?.editor]
    ].filter(([, get]) => {
      try {
        return Boolean(get());
      } catch {
        return false;
      }
    }).map(([name]) => name);
    facts.push(`routes=${routes.join("/") || "none"}`);
    return facts.join(" ");
  }
  function isWorkspaceBusy(reach2) {
    try {
      return Boolean(reach2.workspace?.isDragging?.());
    } catch {
      return false;
    }
  }
  function applyBlocksDirectly(reach2, view, xml) {
    const workspace = reach2.workspace;
    const Blockly = blocklyOf(view, workspace);
    if (!workspace || !Blockly?.Xml) {
      return { mode: "import", detail: workspace ? "no Blockly.Xml" : "no workspace" };
    }
    let dom;
    try {
      dom = Blockly.utils.xml.textToDom(xml);
    } catch (error) {
      return { mode: "import", detail: `unparseable XML: ${describe(error)}` };
    }
    Blockly.Events.disable();
    let merged;
    try {
      merged = mergeIntoWorkspace(Blockly, workspace, dom);
    } catch (error) {
      merged = `merge threw: ${describe(error)}`;
    } finally {
      Blockly.Events.enable();
    }
    if (merged === void 0) {
      return { mode: "merge", detail: "changed blocks only" };
    }
    const scroll = { x: workspace.scrollX, y: workspace.scrollY, scale: workspace.scale };
    Blockly.Events.disable();
    try {
      Blockly.Xml.clearWorkspaceAndLoadFromXml(dom, workspace);
    } catch (error) {
      return { mode: "import", detail: `reload threw: ${describe(error)}` };
    } finally {
      Blockly.Events.enable();
    }
    workspace.setScale?.(scroll.scale);
    workspace.scroll?.(scroll.x, scroll.y);
    return { mode: "canvas", detail: merged };
  }
  function describe(error) {
    return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  }
  function mergeIntoWorkspace(Blockly, workspace, dom) {
    const incoming = [];
    let variables;
    for (const child of Array.from(dom.children)) {
      const tag = child.tagName.toLowerCase();
      if (tag === "variables") {
        variables = child;
      } else if (tag === "block" || tag === "shadow") {
        incoming.push(child);
      }
    }
    if (!incoming.length && workspace.getTopBlocks(false).length) {
      return "incoming XML has no blocks";
    }
    if (variables) {
      try {
        Blockly.Xml.domToVariables(variables, workspace);
      } catch {
      }
    }
    const unmatched = /* @__PURE__ */ new Map();
    for (const block of workspace.getTopBlocks(false)) {
      unmatched.set(block.id, block);
    }
    const rebuild = [];
    const byContent = [];
    for (const element of incoming) {
      const id = element.getAttribute("id");
      const current = id ? unmatched.get(id) : void 0;
      if (!current) {
        byContent.push(element);
        continue;
      }
      unmatched.delete(current.id);
      if (canonicalize(Blockly.Xml.blockToDom(current)) !== canonicalize(element)) {
        current.dispose(false);
        rebuild.push(element);
      }
    }
    const remaining = /* @__PURE__ */ new Map();
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
    for (const block of unmatched.values()) {
      block.dispose(false);
    }
    for (const element of rebuild) {
      Blockly.Xml.domToBlock(element, workspace);
    }
    return void 0;
  }
  function canonicalize(element, ignoreId = false) {
    const attributes = Array.from(element.attributes).filter((attribute) => !(ignoreId && attribute.name === "id")).map((attribute) => {
      const value = attribute.name === "x" || attribute.name === "y" ? String(Math.round(Number(attribute.value) || 0)) : attribute.value;
      return `${attribute.name}=${value}`;
    }).sort().join(" ");
    const children = Array.from(element.childNodes).map((node) => {
      if (node.nodeType === 1) {
        return canonicalize(node, ignoreId);
      }
      if (node.nodeType === 3) {
        const text = (node.textContent ?? "").trim();
        return text ? `#${text}` : "";
      }
      return "";
    }).filter(Boolean).join("");
    return `<${element.tagName.toLowerCase()} ${attributes}>${children}`;
  }
  function readBlocksDirectly(reach2, view) {
    const workspace = reach2.workspace;
    const Blockly = blocklyOf(view, workspace);
    if (!workspace || !Blockly?.Xml) {
      return void 0;
    }
    try {
      return Blockly.Xml.domToText(Blockly.Xml.workspaceToDom(workspace));
    } catch {
      return void 0;
    }
  }

  // src/webview/makecode/main.ts
  var vscodeApi = acquireVsCodeApi();
  var statusEl = document.getElementById("status");
  var frame = document.getElementById("editor");
  function loadEditor(url) {
    if (frame.tagName.toLowerCase() === "object") {
      frame.data = url;
    } else {
      frame.src = url;
    }
  }
  var POLL_MS = 120;
  var reach;
  var pollTimer;
  var lastPolled;
  async function startEditor(sameOrigin, requireCorp) {
    if (!sameOrigin) {
      loadEditor(ARCADE_EDITOR_URL);
      return;
    }
    showStatus("Loading the MakeCode Arcade editor (same-origin)\u2026");
    try {
      loadEditor(await createBlobEditorUrl(requireCorp));
    } catch (error) {
      showStatus(`Same-origin load failed (${describe2(error)}); using the standard editor.`);
      loadEditor(ARCADE_EDITOR_URL);
    }
  }
  function probeOnce() {
    if (reach?.workspace) {
      return;
    }
    const previous = reach?.detail;
    reach = probeEditor(frame);
    if (reach.sameOrigin && reach.workspace) {
      showStatus(void 0);
      startDirectPolling();
      return;
    }
    if (reach.detail !== previous) {
      showStatus(`Editor reach \u2014 ${reach.detail}`);
    }
  }
  function watchForWorkspace() {
    let attempts = 0;
    const timer2 = setInterval(() => {
      attempts++;
      probeOnce();
      if (reach?.workspace || attempts > 40 || !reach?.sameOrigin) {
        clearInterval(timer2);
      }
    }, 500);
  }
  function startDirectPolling() {
    if (!reach?.sameOrigin || !reach.workspace || pollTimer !== void 0) {
      return;
    }
    pollTimer = setInterval(() => {
      if (Date.now() < settlingUntil) {
        return;
      }
      const blocks = readBlocksDirectly(reach, frame.contentWindow);
      if (blocks && blocks !== lastPolled) {
        lastPolled = blocks;
        sync.onLocalChange(blocks, Date.now());
        pump();
      }
    }, POLL_MS);
  }
  var project = createProject("blocks", "");
  var syncOptions = DEFAULT_SYNC_OPTIONS;
  var sync = new SyncState(syncOptions);
  var booted = false;
  var timer;
  var documentBlocks = "";
  var hostFiles = {};
  var settlingUntil = 0;
  var SETTLE_MS = 2500;
  var deferredApply;
  var deferredTimer;
  function post(message) {
    vscodeApi.postMessage(message);
  }
  function showStatus(message) {
    if (!message) {
      statusEl.hidden = true;
      statusEl.textContent = "";
      return;
    }
    statusEl.hidden = false;
    statusEl.textContent = message;
  }
  function pump() {
    if (timer !== void 0) {
      clearTimeout(timer);
      timer = void 0;
    }
    const effect = sync.next(Date.now());
    if (!effect) {
      return;
    }
    switch (effect.kind) {
      case "broadcast":
        post({ type: "edit", xml: effect.blocks });
        pump();
        return;
      case "apply":
        applyRemote(effect.blocks);
        pump();
        return;
      case "wait":
        timer = setTimeout(pump, Math.max(50, effect.untilMs - Date.now()));
        return;
    }
  }
  function shareProjectFiles() {
    const changed = changedFiles(hostFiles, sharedFiles(project.text));
    if (!Object.keys(changed).length) {
      return;
    }
    hostFiles = { ...hostFiles, ...changed };
    post({ type: "projectFiles", files: changed });
  }
  var simulatorTimer;
  function scheduleSimulatorRestart() {
    if (simulatorTimer !== void 0) {
      clearTimeout(simulatorTimer);
    }
    simulatorTimer = setTimeout(() => {
      simulatorTimer = void 0;
      frame.contentWindow?.postMessage(editorCommand("restartsimulator"), "*");
    }, 700);
  }
  function applyRemote(blocks) {
    if (reach?.sameOrigin && isWorkspaceBusy(reach)) {
      deferredApply = blocks;
      if (deferredTimer === void 0) {
        deferredTimer = setTimeout(() => {
          deferredTimer = void 0;
          const pending = deferredApply;
          deferredApply = void 0;
          if (pending !== void 0) {
            applyRemote(pending);
          }
        }, POLL_MS);
      }
      return;
    }
    deferredApply = void 0;
    const current = reach?.sameOrigin ? readBlocksDirectly(reach, frame.contentWindow) : void 0;
    if (sameBlocks(blocks, current ?? blocksOf(project))) {
      lastPolled = current ?? blocks;
      return;
    }
    project = withBlocks(project, blocks);
    probeOnce();
    const applied = reach?.sameOrigin ? applyBlocksDirectly(reach, frame.contentWindow, blocks) : { mode: "import", detail: "cross-origin" };
    console.log(`[blocks] applied via ${applied.mode}: ${applied.detail}`);
    if (applied.mode === "import") {
      frame.contentWindow?.postMessage(importProjectMessage(project), "*");
      settlingUntil = Date.now() + SETTLE_MS;
      lastPolled = blocks;
    } else {
      lastPolled = readBlocksDirectly(reach, frame.contentWindow) ?? blocks;
      scheduleSimulatorRestart();
    }
    showStatus(void 0);
  }
  window.addEventListener("message", (event) => {
    const data = event.data;
    if (data?.type === "init" || data?.type === "update" || data?.type === "projectUpdate") {
      handleHostMessage(data);
      return;
    }
    if (data?.type === "blocksEditorSave") {
      post({ type: "save" });
      return;
    }
    const outcome = handleEditorMessage(event.data, project);
    switch (outcome.kind) {
      case "reply":
        frame.contentWindow?.postMessage(outcome.message, "*");
        return;
      case "projectChanged": {
        const blocks = blocksOf(outcome.project);
        if (Date.now() < settlingUntil) {
          lastPolled = blocks;
          return;
        }
        if (hasNoBlocks(blocks) && !hasNoBlocks(documentBlocks)) {
          showStatus(
            'The MakeCode editor opened empty, so this file has NOT been changed. Close and reopen it; if it keeps happening, switch blocksEditor.engine to "blockly".'
          );
          return;
        }
        if (blocks) {
          project = outcome.project;
          sync.onLocalChange(blocks, Date.now());
          pump();
        }
        shareProjectFiles();
        return;
      }
      case "status":
        probeOnce();
        if (!reach?.workspace) {
          watchForWorkspace();
        }
        return;
      case "ignore":
        return;
    }
  });
  function handleHostMessage(message) {
    switch (message.type) {
      case "init":
        syncOptions = {
          sendDebounceMs: message.debounceMs,
          applyAfterIdleMs: message.remoteApplyDelayMs
        };
        documentBlocks = message.xml;
        hostFiles = { ...message.files };
        project = withFiles(createProject("blocks", message.xml), message.files);
        sync = new SyncState(syncOptions);
        sync.onRemoteChange(message.xml, Date.now());
        if (!booted) {
          booted = true;
          showStatus("Loading the MakeCode Arcade editor\u2026");
          void startEditor(message.embedElement === "blob", message.requireCorp);
          sync.next(Date.now());
        } else {
          pump();
        }
        return;
      case "projectUpdate": {
        hostFiles = { ...hostFiles, ...message.files };
        project = withFiles(project, message.files);
        frame.contentWindow?.postMessage(importProjectMessage(project), "*");
        settlingUntil = Date.now() + SETTLE_MS;
        showStatus(void 0);
        return;
      }
      case "update":
        documentBlocks = message.xml;
        sync.onRemoteChange(message.xml, Date.now());
        if (sync.hasPendingRemote()) {
          showStatus("A change from someone else will apply when you pause\u2026");
        }
        pump();
        return;
    }
  }
  setTimeout(() => {
    if (!booted) {
      return;
    }
    if (statusEl.textContent?.startsWith("Loading")) {
      showStatus(
        "The MakeCode editor did not load. Your file has not been changed."
      );
      post({ type: "editorUnavailable" });
    }
  }, 3e4);
  function describe2(error) {
    return error instanceof Error ? error.message : String(error);
  }
  window.addEventListener(
    "keydown",
    (event) => {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "s") {
        event.preventDefault();
        post({ type: "save" });
      }
    },
    true
  );
  post({ type: "ready" });
})();
//# sourceMappingURL=makecodeEditor.js.map
