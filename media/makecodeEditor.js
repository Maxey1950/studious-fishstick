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
  var SyncState = class _SyncState {
    constructor(options = DEFAULT_SYNC_OPTIONS) {
      this.options = options;
      this.state = { lastLocalChangeMs: Number.NEGATIVE_INFINITY, sentHistory: [] };
    }
    static {
      /** How many recent sends to recognize. A drag is a handful; this is slack. */
      this.HISTORY = 24;
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
      if (blocks === this.state.local || this.state.sentHistory.includes(blocks)) {
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
          this.remember(blocks);
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
          this.remember(blocks);
          return { kind: "apply", blocks };
        }
        return { kind: "wait", untilMs: dueAt };
      }
      return void 0;
    }
    /** Records content as ours, so its echo is never applied back over the user. */
    remember(blocks) {
      this.state.sentHistory.push(blocks);
      if (this.state.sentHistory.length > _SyncState.HISTORY) {
        this.state.sentHistory.shift();
      }
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
    const corsed = requireCorp ? requestAsCors(framed) : framed;
    const patched = corsed.replace(
      /<head([^>]*)>/i,
      `<head$1><base href="${origin}/">${controllerShim()}${SAVE_SHIM}${requireCorp ? ELEMENT_SHIM : ""}${WORKER_SHIM}`
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
  // workspace \u2014 so watching the hook being called gets us both, though neither
  // is ever a global.
  //
  // Wrapping it once is not enough: the target assigns its own function onto
  // pxt.editor during startup, which replaces any wrapper already sitting
  // there. So the property itself is redefined \u2014 every assignment is caught and
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
  function requestAsCors(html) {
    return html.replace(
      /<(script|link)\s([^>]*(?:src|href)="https:\/\/[^"]*"[^>]*)>/gi,
      (tag, name, attributes) => /crossorigin/i.test(attributes) ? tag : `<${name} crossorigin="anonymous" ${attributes}>`
    );
  }
  var ELEMENT_SHIM = `<script>(function () {
  var create = document.createElement.bind(document);
  document.createElement = function (tag) {
    var element = create.apply(null, arguments);
    try {
      var name = String(tag).toLowerCase();
      if (name === 'iframe') {
        // Embeddable under a require-corp document, which the simulator's own
        // origin does not claim to be.
        element.credentialless = true;
      } else if (name === 'script' || name === 'link' || name === 'img') {
        // Fetched as CORS, which is the other way to satisfy that policy.
        element.crossOrigin = 'anonymous';
      }
    } catch (e) {}
    return element;
  };

  // React builds its images with the Image constructor rather than
  // createElement, so the editor's logos go through here instead.
  var NativeImage = window.Image;
  if (NativeImage) {
    window.Image = function () {
      var image = new NativeImage(arguments[0], arguments[1]);
      try { image.crossOrigin = 'anonymous'; } catch (e) {}
      return image;
    };
    window.Image.prototype = NativeImage.prototype;
  }
}());<\/script>`;
  var WORKER_SHIM = `<script>(function () {
  var Native = window.Worker;
  if (!Native) { return; }

  function bootstrap(href) {
    return '(' + function (src) {
      var queued = [];
      self.onmessage = function (event) { queued.push(event); };
      fetch(src, { mode: 'cors', credentials: 'omit' })
        .then(function (response) { return response.text(); })
        .then(function (text) {
          self.onmessage = null;
          var local = URL.createObjectURL(
            new Blob([text], { type: 'application/javascript' })
          );
          importScripts(local);
          var held = queued;
          queued = [];
          held.forEach(function (event) {
            self.dispatchEvent(new MessageEvent('message', { data: event.data }));
          });
        })
        .catch(function (error) {
          setTimeout(function () { throw error; });
        });
    }.toString() + ')(' + JSON.stringify(href) + ');';
  }

  window.Worker = function (url, options) {
    var href = new URL(url, document.baseURI).href;
    if (new URL(href).origin === location.origin) {
      return new Native(url, options);
    }
    var blob = new Blob([bootstrap(href)], { type: 'application/javascript' });
    return new Native(URL.createObjectURL(blob), options);
  };
  window.Worker.prototype = Native.prototype;
}());<\/script>`;
  function blocklyOf(view, workspace) {
    if (view.__arcadeNamespace?.Xml) {
      return view.__arcadeNamespace;
    }
    const candidate = view.__arcadeBlockly ?? view.Blockly;
    if (candidate?.Xml) {
      return candidate;
    }
    for (const route of [
      // pxt keeps the bundled Blockly behind an accessor rather than a property,
      // which is why every search of the object graph came back empty: it is not
      // stored anywhere to be found, it has to be asked for.
      () => view.pxt?.blocks?.requireBlockly?.(),
      () => view.pxt?.blocks?.requirePxtBlockly?.(),
      () => workspace?.options?.Blockly,
      () => workspace?.Blockly,
      () => workspace?.constructor?.Blockly
    ]) {
      try {
        const found2 = route();
        if (found2?.Xml) {
          return found2;
        }
      } catch {
      }
    }
    if (view.__arcadeNamespaceSearched) {
      return candidate;
    }
    const found = findBlockly(view, workspace);
    try {
      view.__arcadeNamespaceSearched = true;
    } catch {
    }
    if (found) {
      try {
        view.__arcadeNamespace = found;
      } catch {
      }
      return found;
    }
    return candidate;
  }
  function isBlockly(value) {
    try {
      return Boolean(
        value && value.Xml && typeof value.Xml.domToText === "function" && typeof value.Xml.domToBlock === "function" && value.Events && typeof value.Events.disable === "function"
      );
    } catch {
      return false;
    }
  }
  function findBlockly(view, workspace) {
    const test = (value) => isBlockly(value) ? value : void 0;
    const seen = /* @__PURE__ */ new Set();
    const guarded = (value) => {
      if (!value || seen.has(value)) {
        return void 0;
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
    return descend(workspace, 2, guarded);
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
      detail: workspace ? `same-origin, workspace reachable via ${workspaceRoute}, xml=${Boolean(blocklyOf(view, workspace)?.Xml)} (globals: ${globals.join(", ") || "none"})` : `same-origin, no workspace \u2014 ${describeEditorState(view)}`
    };
  }
  function findWorkspace(view) {
    const candidates = [
      // Captured by the shim as the editor injected it; the reliable route, since
      // MakeCode's Blockly is a bundled module with no global registry to query.
      ["captured", () => view.__arcadeWorkspace],
      // Through the ProjectView the editor handed to its own extension hook.
      ["opts.blocksEditor", () => view.__arcadeOpts?.projectView?.blocksEditor?.editor],
      ["opts.editor", () => view.__arcadeOpts?.projectView?.editor?.editor],
      ["opts.workspace", () => view.__arcadeOpts?.projectView?.blocksEditor?.workspace],
      // Through React, which owns the canvas whether or not any pxt hook fired.
      ["react", () => findWorkspaceViaReact(view)],
      ["Blockly.getMainWorkspace", () => view.Blockly?.getMainWorkspace?.()],
      ["Blockly.common", () => view.Blockly?.common?.getMainWorkspace?.()],
      ["Blockly.common.all", () => view.Blockly?.common?.getAllWorkspaces?.()?.[0]],
      ["Workspace.getAll", () => view.Blockly?.Workspace?.getAll?.()?.[0]],
      ["pxt.blocks", () => view.pxt?.blocks?.getMainWorkspace?.()],
      ["pxtblockly", () => view.pxtblockly?.getMainWorkspace?.()],
      ["pxt.editor", () => view.pxt?.editor?.mainWorkspace]
    ];
    for (const [name, candidate] of candidates) {
      try {
        const workspace = candidate();
        if (isWorkspace(workspace)) {
          workspaceRoute = name;
          return workspace;
        }
      } catch {
      }
    }
    workspaceRoute = "scan";
    return scanForWorkspace(view);
  }
  var workspaceRoute = "none";
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
    const deep = descend(view.__arcadeOpts, 4, test);
    if (deep) {
      return deep;
    }
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
  function findWorkspaceViaReact(view) {
    let node;
    try {
      node = view.document.querySelector(".injectionDiv") ?? view.document.querySelector(".blocklyWorkspace") ?? view.document.querySelector(".blocklySvg");
    } catch {
      return void 0;
    }
    if (!node) {
      return void 0;
    }
    let fiber;
    try {
      const key = Object.keys(node).find(
        (name) => name.startsWith("__reactFiber$") || name.startsWith("__reactInternalInstance$")
      );
      fiber = key ? node[key] : void 0;
    } catch {
      return void 0;
    }
    for (let depth = 0; fiber && depth < 40; depth++) {
      const instance = fiber.stateNode;
      for (const name of ["editor", "workspace", "mainWorkspace"]) {
        try {
          if (isWorkspace(instance?.[name])) {
            return instance[name];
          }
        } catch {
        }
      }
      if (isWorkspace(instance)) {
        return instance;
      }
      try {
        fiber = fiber.return;
      } catch {
        return void 0;
      }
    }
    return void 0;
  }
  function namesOf(value, limit = 40) {
    if (!value) {
      return "none";
    }
    const names = /* @__PURE__ */ new Set();
    try {
      for (const name of Object.getOwnPropertyNames(value)) {
        names.add(name);
      }
      const proto = Object.getPrototypeOf(value);
      if (proto && proto !== Object.prototype) {
        for (const name of Object.getOwnPropertyNames(proto)) {
          if (name !== "constructor") {
            names.add(name);
          }
        }
      }
    } catch {
      return "unreadable";
    }
    const list = [...names];
    return list.slice(0, limit).join(",") + (list.length > limit ? `\u2026+${list.length - limit}` : "");
  }
  function reportEditorApi(view, workspace) {
    const opts = view.__arcadeOpts;
    const projectView = opts?.projectView;
    const lines = [
      `pxt: ${namesOf(view.pxt, 30)}`,
      `pxt.blocks: ${namesOf(view.pxt?.blocks, 40)}`,
      `pxt.editor: ${namesOf(view.pxt?.editor, 30)}`,
      `blocksEditor: ${namesOf(projectView?.blocksEditor, 40)}`,
      `projectView: ${namesOf(projectView, 30)}`,
      `workspace: ${namesOf(workspace, 40)}`
    ];
    console.log(`[blocks] editor API \u2014
${lines.join("\n")}`);
  }
  function descend(value, depth, test) {
    if (!value || depth < 0 || isFrame(value)) {
      return void 0;
    }
    const found = test(value);
    if (found) {
      return found;
    }
    if (depth === 0) {
      return void 0;
    }
    let keys;
    try {
      keys = Object.keys(value);
    } catch {
      return void 0;
    }
    for (const key of keys) {
      let child;
      try {
        child = value[key];
      } catch {
        continue;
      }
      if (!child || typeof child !== "object" && typeof child !== "function") {
        continue;
      }
      const inside = descend(child, depth - 1, test);
      if (inside) {
        return inside;
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
    try {
      const opts = view.__arcadeOpts;
      facts.push(`opts=${opts ? Object.keys(opts).slice(0, 8).join(",") || "empty" : "none"}`);
      const projectView = opts?.projectView;
      facts.push(
        `projectView=${projectView ? Object.keys(projectView).slice(0, 12).join(",") : "none"}`
      );
      const blocksEditor = projectView?.blocksEditor;
      facts.push(
        `blocksEditor=${blocksEditor ? Object.keys(blocksEditor).slice(0, 12).join(",") : "none"}`
      );
      facts.push(`namespace=${Boolean(findBlockly(view))}`);
      facts.push(`react=${Boolean(findWorkspaceViaReact(view))}`);
      facts.push(`pxt=${Object.keys(view.pxt ?? {}).slice(0, 14).join(",") || "none"}`);
      facts.push(
        `pxtBlocks=${Object.keys(view.pxt?.blocks ?? {}).slice(0, 14).join(",") || "none"}`
      );
    } catch {
      facts.push("opts=unreadable");
    }
    return facts.join(" ");
  }
  function isWorkspaceBusy(reach2) {
    try {
      return Boolean(reach2.workspace?.isDragging?.());
    } catch {
      return false;
    }
  }
  function applyBlocksDirectly(reach2, view, xml, base) {
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
      merged = mergeIntoWorkspace(Blockly, workspace, dom, base);
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
  function mergeIntoWorkspace(Blockly, workspace, dom, base) {
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
      if (base && !existedAtBase(base, Blockly, block)) {
        continue;
      }
      block.dispose(false);
    }
    for (const element of rebuild) {
      Blockly.Xml.domToBlock(element, workspace);
    }
    return void 0;
  }
  function baseIndexOf(xml) {
    let dom;
    try {
      dom = new DOMParser().parseFromString(xml, "text/xml");
      if (dom.getElementsByTagName("parsererror").length) {
        return void 0;
      }
    } catch {
      return void 0;
    }
    const ids = /* @__PURE__ */ new Set();
    const contents = /* @__PURE__ */ new Set();
    for (const child of Array.from(dom.documentElement?.children ?? [])) {
      const tag = child.tagName.toLowerCase();
      if (tag !== "block" && tag !== "shadow") {
        continue;
      }
      const id = child.getAttribute("id");
      if (id) {
        ids.add(id);
      }
      contents.add(canonicalize(child, true));
    }
    return { ids, contents };
  }
  function existedAtBase(base, Blockly, block) {
    try {
      if (base.ids.has(block.id)) {
        return true;
      }
      return base.contents.has(canonicalize(Blockly.Xml.blockToDom(block), true));
    } catch {
      return true;
    }
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
  var reportedApi = false;
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
    if (reach.detail !== previous) {
      console.log(`[blocks] reach \u2014 ${reach.detail}`);
    }
    if (reach.sameOrigin && reach.workspace) {
      if (!reportedApi && reach.detail.includes("xml=false")) {
        reportedApi = true;
        reportEditorApi(frame.contentWindow, reach.workspace);
      }
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
      if (isWorkspaceBusy(reach)) {
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
  var agreedBlocks = "";
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
        agreedBlocks = effect.blocks;
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
    const applied = reach?.sameOrigin ? applyBlocksDirectly(reach, frame.contentWindow, blocks, baseIndexOf(agreedBlocks)) : { mode: "import", detail: "cross-origin" };
    console.log(`[blocks] applied via ${applied.mode}: ${applied.detail}`);
    if (applied.mode === "import") {
      frame.contentWindow?.postMessage(importProjectMessage(project), "*");
      settlingUntil = Date.now() + SETTLE_MS;
      lastPolled = blocks;
      agreedBlocks = blocks;
    } else {
      lastPolled = readBlocksDirectly(reach, frame.contentWindow) ?? blocks;
      agreedBlocks = blocks;
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
        agreedBlocks = message.xml;
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
