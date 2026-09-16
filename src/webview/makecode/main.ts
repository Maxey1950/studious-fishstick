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
  hasNoBlocks,
  importProjectMessage,
  withBlocks,
  type ArcadeProject,
} from '../../shared/arcadeProtocol';
import { DEFAULT_SYNC_OPTIONS, SyncState, type SyncOptions } from '../../shared/syncState';

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

/** The project we hand the editor when it asks, kept current as edits land. */
let project: ArcadeProject = createProject('blocks', '');
let syncOptions: SyncOptions = DEFAULT_SYNC_OPTIONS;
let sync = new SyncState(syncOptions);
let booted = false;
let timer: number | undefined;
/** The document as the extension last reported it, for the safety check below. */
let documentBlocks = '';

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

    case 'apply': {
      // Keep pxt.json (the extension list), assets.json and main.ts; only the
      // blocks came from the other participant.
      project = withBlocks(project, effect.blocks);
      frame.contentWindow?.postMessage(importProjectMessage(project), '*');
      showStatus(undefined);
      pump();
      return;
    }

    case 'wait':
      timer = setTimeout(pump, Math.max(50, effect.untilMs - Date.now())) as unknown as number;
      return;
  }
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
      showStatus(undefined);
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
        loadEditor(ARCADE_EDITOR_URL);
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

post({ type: 'ready' });
