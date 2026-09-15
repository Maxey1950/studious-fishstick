import type { HostMessage, RendererName, WebviewMessage } from '../protocol';
import { parseBlocksXml as parse } from './parse';
import { serializeWorkspace } from './serialize';
import { defineStubsFor } from './stubBlocks';
import { TOOLBOX_XML } from './toolbox';

/** Matches `blocksEditor.writeDebounceMs`; the host re-sends it on `init`. */
const DEFAULT_DEBOUNCE_MS = 200;

const vscodeApi = acquireVsCodeApi();

let workspace: any;
let currentRenderer: RendererName | undefined;
let debounceMs = DEFAULT_DEBOUNCE_MS;

/** Set while a host update is being loaded, so the resulting Blockly change
 * events are not echoed straight back to the document. */
let applyingRemote = false;
/** Set between BLOCK_DRAG start/end. A remote update landing mid-drag would rip
 * the block out of the user's hand, so it waits. */
let dragging = false;
let pendingRemoteXml: string | undefined;
/** The last XML that loaded cleanly, used to recover from a failed load. */
let lastLoadedXml: string | undefined;
let writeTimer: number | undefined;

const statusEl = document.getElementById('status') as HTMLDivElement;

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

/** Replaces the workspace contents with `xml`, without reporting an edit back. */
function loadXml(xml: string): void {
  let dom: Element;
  try {
    dom = parse(xml);
  } catch (error) {
    // Half-typed XML is normal while someone edits the file as text, and under
    // Live Share it arrives here keystroke by keystroke. Leave the last good
    // canvas on screen rather than clearing it, and say why it is not moving.
    showStatus(`Waiting — the file is not valid XML right now (${describe(error)}).`);
    return;
  }

  const stubbed = defineStubsFor(dom);

  applyingRemote = true;
  try {
    Blockly.Xml.clearWorkspaceAndLoadFromXml(dom, workspace);
    lastLoadedXml = xml;
  } catch (error) {
    // The workspace was already cleared by the time this threw, so put the last
    // known-good content back rather than leaving an empty canvas.
    showStatus(`Could not load the blocks: ${describe(error)}`);
    restoreLastLoaded();
    return;
  } finally {
    applyingRemote = false;
  }

  showStatus(describeStubs(stubbed));
}

function describeStubs(stubbed: string[]): string | undefined {
  if (stubbed.length === 0) {
    return undefined;
  }
  const shown = stubbed.slice(0, 5).join(', ');
  const rest = stubbed.length > 5 ? `, and ${stubbed.length - 5} more` : '';
  return stubbed.length === 1
    ? `1 block type is not known to this editor and is shown as a placeholder: ${shown}.`
    : `${stubbed.length} block types are not known to this editor and are shown as ` +
        `placeholders: ${shown}${rest}.`;
}

function restoreLastLoaded(): void {
  if (lastLoadedXml === undefined) {
    return;
  }
  applyingRemote = true;
  try {
    Blockly.Xml.clearWorkspaceAndLoadFromXml(parse(lastLoadedXml), workspace);
  } catch {
    // Nothing further to fall back to; the canvas stays empty.
  } finally {
    applyingRemote = false;
  }
}

function serialize(): string {
  return serializeWorkspace(workspace);
}

function scheduleWrite(): void {
  if (writeTimer !== undefined) {
    clearTimeout(writeTimer);
  }
  writeTimer = setTimeout(() => {
    writeTimer = undefined;
    try {
      post({ type: 'edit', xml: serialize() });
    } catch (error) {
      post({ type: 'error', message: `Could not save the blocks: ${describe(error)}` });
    }
  }, debounceMs) as unknown as number;
}

function onWorkspaceChange(event: any): void {
  if (applyingRemote) {
    return;
  }

  // Checked before the UI-event guard below: BlockDrag extends UiBase, so it is
  // itself a UI event, and testing `isUiEvent` first would discard it.
  if (event.type === Blockly.Events.BLOCK_DRAG) {
    dragging = Boolean(event.isStart);
    if (!dragging && pendingRemoteXml !== undefined) {
      const xml = pendingRemoteXml;
      pendingRemoteXml = undefined;
      loadXml(xml);
    }
    // The drag itself changes nothing; the BlockMove that follows it does.
    return;
  }

  // UI-only events (scroll, zoom, selection, opening the toolbox) change nothing
  // in the file and must not produce a document revision — under Live Share
  // every revision is broadcast to every participant.
  if (event.isUiEvent || event.type === Blockly.Events.FINISHED_LOADING) {
    return;
  }

  scheduleWrite();
}

function applyRemote(xml: string): void {
  if (dragging) {
    pendingRemoteXml = xml;
    return;
  }
  // A write of ours may still be queued; the incoming document is newer, so
  // drop it rather than overwriting the other participant a moment later.
  if (writeTimer !== undefined) {
    clearTimeout(writeTimer);
    writeTimer = undefined;
  }
  if (xml === safeSerialize()) {
    return;
  }
  const scroll = { x: workspace.scrollX, y: workspace.scrollY, scale: workspace.scale };
  loadXml(xml);
  workspace.setScale(scroll.scale);
  workspace.scroll(scroll.x, scroll.y);
}

/** Serializes without throwing, for comparisons where a failure just means
 * "assume it differs". */
function safeSerialize(): string | undefined {
  try {
    return serialize();
  } catch {
    return undefined;
  }
}

function boot(renderer: RendererName, mediaUri: string, editable: boolean): void {
  workspace = Blockly.inject('blockly', {
    toolbox: Blockly.utils.xml.textToDom(TOOLBOX_XML),
    renderer,
    media: mediaUri,
    readOnly: !editable,
    trashcan: true,
    zoom: { controls: true, wheel: true, startScale: 0.9, minScale: 0.3, maxScale: 3 },
    move: { scrollbars: true, drag: true, wheel: true },
    grid: { spacing: 24, length: 3, colour: 'rgba(128,128,128,0.25)', snap: true },
  });
  currentRenderer = renderer;
  workspace.addChangeListener(onWorkspaceChange);
  window.addEventListener('resize', () => Blockly.svgResize(workspace));
}

window.addEventListener('message', (event: MessageEvent<HostMessage>) => {
  const message = event.data;
  switch (message.type) {
    case 'init': {
      debounceMs = message.debounceMs;
      // The renderer is fixed at injection time, so switching it means throwing
      // the workspace away and building a new one.
      if (workspace && currentRenderer !== message.renderer) {
        workspace.dispose();
        workspace = undefined;
      }
      if (!workspace) {
        boot(message.renderer, message.mediaUri, message.editable);
      }
      loadXml(message.xml);
      return;
    }
    case 'update':
      if (workspace) {
        applyRemote(message.xml);
      }
      return;
  }
});

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

post({ type: 'ready' });
