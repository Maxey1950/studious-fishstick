"use strict";
(() => {
  // src/shared/arcadeProtocol.ts
  var ARCADE_EDITOR_URL = "https://arcade.makecode.com/?controller=1&ws=browser&nocookiebanner=1";
  function handleEditorMessage(message, project2) {
    if (!message || typeof message !== "object" || message.type !== "pxteditor") {
      return { kind: "ignore" };
    }
    switch (message.action) {
      case "workspacesync":
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
    return { type: "pxthost", action: "importproject", project: project2 };
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

  // src/shared/syncState.ts
  var DEFAULT_SYNC_OPTIONS = {
    sendDebounceMs: 700,
    applyAfterIdleMs: 2e3
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

  // src/webview/makecode/main.ts
  var vscodeApi = acquireVsCodeApi();
  var statusEl = document.getElementById("status");
  var frame = document.getElementById("editor");
  var project = createProject("blocks", "");
  var sync = new SyncState(DEFAULT_SYNC_OPTIONS);
  var booted = false;
  var timer;
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
        project = createProject("blocks", effect.blocks);
        frame.contentWindow?.postMessage(importProjectMessage(project), "*");
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
        if (blocks) {
          project = outcome.project;
          sync.onLocalChange(blocks, Date.now());
          pump();
        }
        return;
      }
      case "status":
        showStatus(void 0);
        return;
      case "ignore":
        return;
    }
  });
  function handleHostMessage(message) {
    switch (message.type) {
      case "init":
        project = createProject("blocks", message.xml);
        sync = new SyncState(DEFAULT_SYNC_OPTIONS);
        sync.onRemoteChange(message.xml, Date.now());
        if (!booted) {
          booted = true;
          showStatus("Loading the MakeCode Arcade editor\u2026");
          frame.src = ARCADE_EDITOR_URL;
          sync.next(Date.now());
        } else {
          pump();
        }
        return;
      case "update":
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
        "The MakeCode editor has not responded. It may be blocked on this network, or the editor may still be starting."
      );
    }
  }, 3e4);
  post({ type: "ready" });
})();
//# sourceMappingURL=makecodeEditor.js.map
