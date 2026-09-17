/**
 * The MakeCode engine: the real Arcade editor, embedded.
 *
 * Instead of drawing blocks with Blockly, this loads arcade.makecode.com in an
 * iframe and speaks MakeCode's controller protocol to it. The editor is the
 * genuine article — real image and tilemap editors, real simulator, every block
 * — and the `.blocks` document remains the source of truth, so Live Share
 * replicates changes exactly as it does for the Blockly engine.
 *
 * It implements the same host/webview protocol as the Blockly engine, so the
 * extension side does not care which one is running.
 */
import type { HostMessage, WebviewMessage } from '../../protocol';
import {
  ARCADE_EDITOR_URL,
  blocksOf,
  createProject,
  handleEditorMessage,
  editorCommand,
  hasNoBlocks,
  importProjectMessage,
  withBlocks,
  type ArcadeProject,
} from '../../shared/arcadeProtocol';
import { DEFAULT_SYNC_OPTIONS, SyncState, type SyncOptions } from '../../shared/syncState';
import {
  applyBlocksDirectly,
  createBlobEditorUrl,
  isWorkspaceBusy,
  probeEditor,
  readBlocksDirectly,
  type EditorReach,
} from './sameOrigin';

const vscodeApi = acquireVsCodeApi();

const statusEl = document.getElementById('status') as HTMLDivElement;
/** An <iframe>, <object> or <embed>, depending on the setting. Each exposes a
 * `contentWindow`, which is all the controller protocol needs. */
const frame = document.getElementById('editor') as HTMLIFrameElement &
  HTMLObjectElement &
  HTMLEmbedElement;

/** `<object>` names its source `data`; the other two use `src`. */
function loadEditor(url: string): void {
  if (frame.tagName.toLowerCase() === 'object') {
    frame.data = url;
  } else {
    frame.src = url;
  }
}

/**
 * How often the workspace is read.
 *
 * Short, because reading it is a serialization of blocks already in memory —
 * cheap next to the round trip through the file and Live Share that follows.
 */
const POLL_MS = 120;

/** What we can reach inside the editor once it is up. */
let reach: EditorReach | undefined;
let pollTimer: number | undefined;
let lastPolled: string | undefined;

/**
 * Starts the editor, same-origin when asked for.
 *
 * A failed experiment should leave a working editor rather than a blank panel,
 * so anything going wrong here falls back to the ordinary cross-origin load.
 */
async function startEditor(sameOrigin: boolean): Promise<void> {
  if (!sameOrigin) {
    loadEditor(ARCADE_EDITOR_URL);
    return;
  }

  showStatus('Loading the MakeCode Arcade editor (same-origin)\u2026');
  try {
    loadEditor(await createBlobEditorUrl());
  } catch (error) {
    showStatus(`Same-origin load failed (${describe(error)}); using the standard editor.`);
    loadEditor(ARCADE_EDITOR_URL);
  }
}

/**
 * Works out whether the editor's internals are reachable.
 *
 * Deliberately re-probes while same-origin but workspace-less: the workspace
 * does not exist until the editor has finished starting and loaded a project,
 * which happens well after the document itself is ready. Caching the first
 * answer would leave us falling back to reloads forever, on an editor we can
 * actually reach.
 */
function probeOnce(): void {
  if (reach?.workspace) {
    return;
  }
  const previous = reach?.detail;
  reach = probeEditor(frame);

  if (reach.sameOrigin && reach.workspace) {
    showStatus(undefined);
    startDirectPolling();
    return;
  }
  if (reach.detail !== previous) {
    // Worth saying out loud: it explains why changes still reload the editor.
    showStatus(`Editor reach \u2014 ${reach.detail}`);
  }
}

/** Keeps looking for the workspace while the editor is still starting up. */
function watchForWorkspace(): void {
  let attempts = 0;
  const timer = setInterval(() => {
    attempts++;
    probeOnce();
    if (reach?.workspace || attempts > 40 || !reach?.sameOrigin) {
      clearInterval(timer);
    }
  }, 500);
}

/**
 * Reads the workspace on a timer rather than waiting for MakeCode to save.
 *
 * Its own save debounce is most of the delay before a change reaches the other
 * participant, and being same-origin means we do not have to wait for it.
 */
function startDirectPolling(): void {
  if (!reach?.sameOrigin || !reach.workspace || pollTimer !== undefined) {
    return;
  }
  pollTimer = setInterval(() => {
    if (Date.now() < settlingUntil) {
      return;
    }
    const blocks = readBlocksDirectly(reach!, frame.contentWindow as unknown);
    if (blocks && blocks !== lastPolled) {
      lastPolled = blocks;
      sync.onLocalChange(blocks, Date.now());
      pump();
    }
  }, POLL_MS) as unknown as number;
}

/** The project we hand the editor when it asks, kept current as edits land. */
let project: ArcadeProject = createProject('blocks', '');
let syncOptions: SyncOptions = DEFAULT_SYNC_OPTIONS;
let sync = new SyncState(syncOptions);
let booted = false;
let timer: number | undefined;
/** The document as the extension last reported it, for the safety check below. */
let documentBlocks = '';
/**
 * While set, the editor is still settling after an import and anything it
 * reports is an echo of that import rather than a person's edit.
 *
 * Importing a project makes the editor re-save it, and MakeCode does not
 * reproduce the XML byte for byte — it normalizes as it goes. That difference
 * reads as a fresh edit, gets written to the file, comes back as a change, and
 * is imported again: the editor reloads forever, with nobody editing anything.
 */
let settlingUntil = 0;
const SETTLE_MS = 2500;
/** A peer's blocks waiting for the user to finish a drag. */
let deferredApply: string | undefined;
let deferredTimer: number | undefined;

function post(message: WebviewMessage): void {
  vscodeApi.postMessage(message);
}

function showStatus(message: string | undefined): void {
  if (!message) {
    statusEl.hidden = true;
    statusEl.textContent = '';
    return;
  }
  statusEl.hidden = false;
  statusEl.textContent = message;
}

/** Runs the sync decisions the state machine hands back. */
function pump(): void {
  if (timer !== undefined) {
    clearTimeout(timer);
    timer = undefined;
  }

  const effect = sync.next(Date.now());
  if (!effect) {
    return;
  }

  switch (effect.kind) {
    case 'broadcast':
      // "Broadcast" here means writing to the document; Live Share does the
      // rest, the same way it does for the Blockly engine.
      post({ type: 'edit', xml: effect.blocks });
      pump();
      return;

    case 'apply':
      applyRemote(effect.blocks);
      pump();
      return;

    case 'wait':
      timer = setTimeout(pump, Math.max(50, effect.untilMs - Date.now())) as unknown as number;
      return;
  }
}

/**
 * Restarts the simulator a moment after the last applied change.
 *
 * Debounced because a burst of incoming changes should cost one restart, not
 * one per block.
 */
let simulatorTimer: number | undefined;
function scheduleSimulatorRestart(): void {
  if (simulatorTimer !== undefined) {
    clearTimeout(simulatorTimer);
  }
  simulatorTimer = setTimeout(() => {
    simulatorTimer = undefined;
    frame.contentWindow?.postMessage(editorCommand('restartsimulator'), '*');
  }, 700) as unknown as number;
}

/**
 * Puts a peer's blocks into the editor.
 *
 * Deferred while a block is in the user's hand: applying mid-drag would dispose
 * the block they are holding. The wait is a few frames, not a policy — the drag
 * ends and the change lands.
 */
function applyRemote(blocks: string): void {
  if (reach?.sameOrigin && isWorkspaceBusy(reach)) {
    deferredApply = blocks;
    if (deferredTimer === undefined) {
      deferredTimer = setTimeout(() => {
        deferredTimer = undefined;
        const pending = deferredApply;
        deferredApply = undefined;
        if (pending !== undefined) {
          applyRemote(pending);
        }
      }, POLL_MS) as unknown as number;
    }
    return;
  }
  deferredApply = undefined;

  // Keep pxt.json (the extension list), assets.json and main.ts; only the
  // blocks came from the other participant.
  project = withBlocks(project, blocks);

  probeOnce();
  // Same-origin lets the change go straight into the workspace, leaving the
  // editor, toolbox and simulator standing. Otherwise importproject is the
  // only route in, and it rebuilds all of them.
  const applied = reach?.sameOrigin
    ? applyBlocksDirectly(reach, frame.contentWindow as unknown, blocks)
    : ({ mode: 'import', detail: 'cross-origin' } as const);

  // Say which route the change took. A reload is the thing we are trying to
  // avoid, so when one happens it should be possible to read why rather than
  // guess at it.
  console.log(`[blocks] applied via ${applied.mode}: ${applied.detail}`);

  if (applied.mode === 'import') {
    frame.contentWindow?.postMessage(importProjectMessage(project), '*');
    // Only the import route needs a settling window; applying to the workspace
    // directly does not make the editor re-save.
    settlingUntil = Date.now() + SETTLE_MS;
    lastPolled = blocks;
  } else {
    // What the workspace now serializes to is not byte-for-byte what arrived —
    // Blockly spells the same blocks its own way. Remembering the arriving text
    // would make the very next poll read a difference, call it a local edit and
    // send it straight back, which is the loop that had the editor rebuilding
    // itself every few hundred milliseconds. Remember what the workspace
    // actually says instead.
    lastPolled = readBlocksDirectly(reach!, frame.contentWindow as unknown) ?? blocks;
    // Blockly's events were off while the blocks went in, so the editor does not
    // know its code changed and the simulator is still running the old program.
    // Ask it to start again, once the changes stop arriving.
    scheduleSimulatorRestart();
  }

  showStatus(undefined);
}

window.addEventListener('message', (event: MessageEvent) => {
  // Two senders share this channel: the extension host and the embedded editor.
  // Extension messages carry our own protocol's `type`; editor messages carry
  // MakeCode's.
  const data = event.data as HostMessage & { type?: string };

  if (data?.type === 'init' || data?.type === 'update') {
    handleHostMessage(data as HostMessage);
    return;
  }

  const outcome = handleEditorMessage(event.data, project);
  switch (outcome.kind) {
    case 'reply':
      frame.contentWindow?.postMessage(outcome.message, '*');
      return;

    case 'projectChanged': {
      const blocks = blocksOf(outcome.project);

      // If the editor reports an empty workspace while the file has blocks in
      // it, the editor failed to load the project rather than the user deleting
      // everything. Saving that would destroy their work, so refuse.
      // Anything arriving while the editor settles after an import is that
      // import coming back, not a person's edit.
      if (Date.now() < settlingUntil) {
        lastPolled = blocks;
        return;
      }

      if (hasNoBlocks(blocks) && !hasNoBlocks(documentBlocks)) {
        showStatus(
          'The MakeCode editor opened empty, so this file has NOT been changed. ' +
            'Close and reopen it; if it keeps happening, switch blocksEditor.engine to "blockly".'
        );
        return;
      }

      if (blocks) {
        // Keep every file the editor produced (main.ts, assets.json), not just
        // the blocks, so nothing it generated is thrown away on the next import.
        project = outcome.project;
        sync.onLocalChange(blocks, Date.now());
        pump();
      }
      return;
    }

    case 'status':
      probeOnce();
      // The editor reports itself ready before its workspace exists, so keep
      // watching for it rather than settling for the first answer.
      if (!reach?.workspace) {
        watchForWorkspace();
      }
      return;

    case 'ignore':
      return;
  }
});

function handleHostMessage(message: HostMessage): void {
  switch (message.type) {
    case 'init':
      syncOptions = {
        sendDebounceMs: message.debounceMs,
        applyAfterIdleMs: message.remoteApplyDelayMs,
      };
      documentBlocks = message.xml;
      project = createProject('blocks', message.xml);
      sync = new SyncState(syncOptions);
      sync.onRemoteChange(message.xml, Date.now());
      if (!booted) {
        booted = true;
        showStatus('Loading the MakeCode Arcade editor…');
        void startEditor(message.embedElement === 'blob');
        // The editor asks for the project itself once it is up; the pending
        // remote change is consumed by that request rather than by an import.
        sync.next(Date.now());
      } else {
        pump();
      }
      return;

    case 'update':
      documentBlocks = message.xml;
      sync.onRemoteChange(message.xml, Date.now());
      if (sync.hasPendingRemote()) {
        showStatus('A change from someone else will apply when you pause…');
      }
      pump();
      return;
  }
}

// The editor can fail to load without firing an error, so say so rather than
// leaving a blank panel.
setTimeout(() => {
  if (!booted) {
    return;
  }
  if (statusEl.textContent?.startsWith('Loading')) {
    showStatus(
      'The MakeCode editor did not load. Your file has not been changed.'
    );
    post({ type: 'editorUnavailable' });
  }
}, 30000);

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

post({ type: 'ready' });
