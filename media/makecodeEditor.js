"use strict";
(() => {
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
          message: { type: "pxthost", id: message.id, success: true, projects: [project2] }
        };
      case "newproject":
        return {
          kind: "reply",
          message: { type: "pxthost", id: message.id, success: true, projects: [project2] }
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
    return { type: "pxteditor", action: "importproject", project: project2 };
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

  // src/shared/syncState.ts
  var DEFAULT_SYNC_OPTIONS = {
    sendDebounceMs: 250,
    applyAfterIdleMs: 900
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
  async function createBlobEditorUrl() {
    const response = await fetch(ARCADE_EDITOR_URL, { credentials: "omit" });
    if (!response.ok) {
      throw new Error(`MakeCode returned ${response.status}`);
    }
    const html = await response.text();
    const origin = new URL(ARCADE_EDITOR_URL).origin;
    const absolute = html.replace(/"\/---/g, `"${origin}/---`);
    const patched = absolute.replace(
      /<head([^>]*)>/i,
      `<head$1><base href="${origin}/">${controllerShim()}${WORKER_SHIM}`
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
          try { window.__arcadeWorkspace = workspace; } catch (e) {}
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
        if (workspace?.getAllBlocks) {
          return workspace;
        }
      } catch {
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
  function applyBlocksDirectly(reach2, view, xml) {
    const workspace = reach2.workspace;
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
  function readBlocksDirectly(reach2, view) {
    const workspace = reach2.workspace;
    const Blockly = view.Blockly;
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
  var reach;
  var pollTimer;
  var lastPolled;
  async function startEditor(sameOrigin) {
    if (!sameOrigin) {
      loadEditor(ARCADE_EDITOR_URL);
      return;
    }
    showStatus("Loading the MakeCode Arcade editor (same-origin)\u2026");
    try {
      loadEditor(await createBlobEditorUrl());
    } catch (error) {
      showStatus(`Same-origin load failed (${describe(error)}); using the standard editor.`);
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
      const blocks = readBlocksDirectly(reach, frame.contentWindow);
      if (blocks && blocks !== lastPolled) {
        lastPolled = blocks;
        sync.onLocalChange(blocks, Date.now());
        pump();
      }
    }, 300);
  }
  var project = createProject("blocks", "");
  var syncOptions = DEFAULT_SYNC_OPTIONS;
  var sync = new SyncState(syncOptions);
  var booted = false;
  var timer;
  var documentBlocks = "";
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
      case "apply": {
        project = withBlocks(project, effect.blocks);
        probeOnce();
        const appliedDirectly = reach?.sameOrigin === true && applyBlocksDirectly(reach, frame.contentWindow, effect.blocks);
        if (!appliedDirectly) {
          frame.contentWindow?.postMessage(importProjectMessage(project), "*");
        }
        lastPolled = effect.blocks;
        showStatus(void 0);
        pump();
        return;
      }
      case "wait":
        timer = setTimeout(pump, Math.max(50, effect.untilMs - Date.now()));
        return;
    }
  }
  window.addEventListener("message", (event) => {
    const data = event.data;
    if (data?.type === "init" || data?.type === "update") {
      handleHostMessage(data);
      return;
    }
    const outcome = handleEditorMessage(event.data, project);
    switch (outcome.kind) {
      case "reply":
        frame.contentWindow?.postMessage(outcome.message, "*");
        return;
      case "projectChanged": {
        const blocks = blocksOf(outcome.project);
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
        project = createProject("blocks", message.xml);
        sync = new SyncState(syncOptions);
        sync.onRemoteChange(message.xml, Date.now());
        if (!booted) {
          booted = true;
          showStatus("Loading the MakeCode Arcade editor\u2026");
          void startEditor(message.embedElement === "blob");
          sync.next(Date.now());
        } else {
          pump();
        }
        return;
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
  function describe(error) {
    return error instanceof Error ? error.message : String(error);
  }
  post({ type: "ready" });
})();
//# sourceMappingURL=makecodeEditor.js.map
