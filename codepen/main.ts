/**
 * Arcade Collab: the real MakeCode Arcade editor in a plain web page, with
 * live collaboration and a level system.
 *
 * A standalone port of the VS Code extension's MakeCode engine, for when
 * vscode.dev is not usable. Everything that made the extension work is reused
 * unchanged — the same-origin blob loader and its shims, the block-by-block
 * merge, the echo handling, the guard that keeps a half-loaded editor from
 * overwriting a level — and only the outside is new:
 *
 *   - Storage is the browser's IndexedDB instead of a file on disk. Export and
 *     Import move a whole project in and out.
 *   - Changes travel over a pluggable channel instead of Live Share. Between
 *     tabs of one browser that needs nothing; between two computers it needs a
 *     WebSocket relay (see relay.mjs).
 *   - A project is a set of levels — level1.blocks … level10.blocks — sharing
 *     one set of assets. Only the current level is ever in the editor, and the
 *     running game can ask for the next one.
 */
import {
  blocksOf,
  createProject,
  editorCommand,
  handleEditorMessage,
  hasNoBlocks,
  importProjectMessage,
  type ArcadeProject,
} from '../src/shared/arcadeProtocol';
import { countBlocks } from '../src/shared/history';
import { changedFiles, isShared, sharedFiles, withFiles, type ProjectText } from '../src/shared/projectFiles';
import { sameBlocks } from '../src/shared/sameBlocks';
import { DEFAULT_SYNC_OPTIONS, SyncState } from '../src/shared/syncState';
import { Peer, type DataConnection } from 'peerjs';
import {
  applyBlocksDirectly,
  baseIndexOf,
  createBlobEditorUrl,
  highlightBlocks,
  isWorkspaceBusy,
  probeEditor,
  readBlocksDirectly,
  type EditorReach,
} from '../src/webview/makecode/sameOrigin';

// ---------------------------------------------------------------------------
// The project
// ---------------------------------------------------------------------------

/** Each level's blocks, by name: "level1" holds what level1.blocks holds. */
type Levels = Record<string, string>;

interface Store {
  levels: Levels;
  /** Everything else in the project folder, shared by every level. */
  shared: ProjectText;
  /** The level in the editor right now. */
  current: string;
  /**
   * Whether the project is split into levels. Off, the editor holds one program
   * and the level controls and game signals are switched off; the other levels'
   * blocks are kept, untouched, for when it is switched back on.
   */
  levelsEnabled: boolean;
}

/** What a new level starts as: the empty on-start block of a fresh project. */
const EMPTY_LEVEL =
  '<xml xmlns="https://developers.google.com/blockly/xml">' +
  '<block type="pxt-on-start" x="0" y="0"></block></xml>';

let store: Store = {
  levels: { level1: EMPTY_LEVEL },
  shared: {},
  current: 'level1',
  levelsEnabled: false,
};

/** Levels in play order: level2 before level10, which a plain sort gets wrong. */
function levelNames(): string[] {
  return Object.keys(store.levels).sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
  );
}

/** The current level as a MakeCode project: its blocks plus the shared files. */
function buildProject(): ArcadeProject {
  return withFiles(
    createProject(store.current, store.levels[store.current] ?? EMPTY_LEVEL),
    store.shared
  );
}

// ---------------------------------------------------------------------------
// Storage
//
// IndexedDB rather than localStorage: images and tilemaps make a project
// megabytes, past localStorage's limit — and on CodePen that limit is shared
// with every other pen, since they all run on the same origin.
// ---------------------------------------------------------------------------

const DB_NAME = 'arcade-collab';
const DB_STORE = 'state';
const DB_KEY = 'project';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(DB_STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function loadStore(): Promise<Store | undefined> {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const request = db.transaction(DB_STORE).objectStore(DB_STORE).get(DB_KEY);
      request.onsuccess = () => resolve(request.result as Store | undefined);
      request.onerror = () => reject(request.error);
    });
  } catch {
    return undefined;
  }
}

async function writeStore(): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readwrite');
    tx.objectStore(DB_STORE).put(store, DB_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

let persistTimer: number | undefined;

/** Saves shortly after the last change, so a drag is one write. */
function persist(): void {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    writeStore().then(
      () => setStatus('Saved'),
      (error) => setStatus(`Could not save: ${describe(error)}`)
    );
  }, 400) as unknown as number;
}

// ---------------------------------------------------------------------------
// The channel to everyone else
// ---------------------------------------------------------------------------

/** Tells this tab's own messages apart when a relay sends them back. */
const ME = Math.random().toString(36).slice(2);

type SyncMessage =
  /** Someone joined and wants the current state. */
  | { type: 'hello'; from: string }
  /** The whole project. `force` replaces even edited work: an explicit import. */
  | {
      type: 'state';
      from: string;
      levels: Levels;
      shared: ProjectText;
      current: string;
      levelsEnabled?: boolean;
      force?: boolean;
    }
  /** The levels switch was flipped. */
  | { type: 'settings'; from: string; levelsEnabled: boolean }
  /** One level's blocks changed. */
  | { type: 'blocks'; from: string; level: string; xml: string }
  /** Shared files changed: an image drawn, an extension added. */
  | { type: 'files'; from: string; files: ProjectText }
  /** Everyone moves to this level. */
  | { type: 'level'; from: string; level: string };

interface Channel {
  label: string;
  send(message: SyncMessage): void;
  close(): void;
}

let channel: Channel | undefined;

/**
 * Between tabs of one browser. Needs no server, so it is the default — and the
 * quickest way to see the live sync working before a relay exists.
 */
function tabsChannel(room: string): Channel {
  const bc = new BroadcastChannel(`arcade-collab:${room}`);
  bc.onmessage = (event) => onSync(event.data as SyncMessage);
  return {
    label: `tabs in this browser (room "${room}")`,
    send: (message) => bc.postMessage(message),
    close: () => bc.close(),
  };
}

/**
 * Between computers, through a relay that passes each message to everyone
 * else in the room. Any server that does that will do; relay.mjs is one.
 */
function socketChannel(url: string, room: string): Channel {
  const address = new URL(url);
  address.searchParams.set('room', room);
  const socket = new WebSocket(address.toString());
  const queue: string[] = [];

  socket.onopen = () => {
    setConn(`Connected to ${address.host}`, 'on');
    for (const text of queue.splice(0)) {
      socket.send(text);
    }
    socket.send(JSON.stringify({ type: 'hello', from: ME }));
  };
  socket.onmessage = (event) => {
    try {
      onSync(JSON.parse(String(event.data)) as SyncMessage);
    } catch {
      // Not ours.
    }
  };
  socket.onclose = () => setConn(`Disconnected from ${address.host}`, 'off');
  socket.onerror = () => setConn(`Could not reach ${address.host}`, 'off');

  return {
    label: address.host,
    send: (message) => {
      const text = JSON.stringify(message);
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(text);
      } else {
        queue.push(text);
      }
    },
    close: () => socket.close(),
  };
}

/** A room name as a PeerJS address allows: letters, digits, single dashes. */
function peerRoom(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'arcade';
}

/**
 * Between computers, directly, with no server of our own.
 *
 * PeerJS's free server only introduces browsers; after that they talk to each
 * other directly. A room is one well-known address on that server,
 * `arcadecollab-<room>`. Whoever opens the room first takes the address and
 * becomes its host; everyone after finds it taken and joins the host instead.
 * The host passes each message on to everyone else, so four people need only
 * one link each to the host, not one to every other person.
 *
 * If the host leaves, the others' links close and each of them tries for the
 * address again after a random pause: one gets it and hosts, the rest join.
 */
function peerChannel(roomName: string): Channel {
  const room = peerRoom(roomName);
  const hostId = `arcadecollab-${room}`;
  const links = new Set<DataConnection>();
  let peer: Peer | undefined;
  let isHost = false;
  let closed = false;
  let retryTimer: number | undefined;

  // Heartbeat. A computer that disappears without saying goodbye — a closed
  // lid, dropped Wi-Fi, a crash — leaves its links looking open for a long
  // time, and without the host noticing it is gone nobody takes over. So every
  // link carries a small "still here" every couple of seconds, and a link that
  // has been silent too long is treated as gone.
  const PING = { type: '__ping' } as const;
  const PING_MS = 2000;
  const SILENT_MS = 7000;
  const lastHeard = new Map<DataConnection, number>();
  const heartbeat = setInterval(() => {
    const now = Date.now();
    for (const link of links) {
      if (now - (lastHeard.get(link) ?? now) > SILENT_MS) {
        drop(link);
      } else if (link.open) {
        link.send(PING);
      }
    }
  }, PING_MS);

  const report = (): void => {
    if (closed) {
      return;
    }
    const others = links.size;
    if (isHost) {
      setConn(
        others
          ? `Room ${room}: hosting, ${others} other${others === 1 ? '' : 's'} connected`
          : `Room ${room}: waiting for friends to join`,
        others ? 'on' : 'wait'
      );
    } else {
      setConn(others ? `Room ${room}: connected` : `Room ${room}: joining...`, others ? 'on' : 'wait');
    }
  };

  const reset = (): void => {
    for (const link of links) {
      link.close();
    }
    links.clear();
    lastHeard.clear();
    peer?.destroy();
    peer = undefined;
  };

  /**
   * A link is gone: forget it, and if it was the host, find a new one. Reached
   * both from the link's own close event and from the heartbeat, so it has to
   * be safe to run twice.
   */
  function drop(link: DataConnection): void {
    if (!links.delete(link)) {
      return;
    }
    lastHeard.delete(link);
    try {
      link.close();
    } catch {
      // Already closing.
    }
    report();
    if (!isHost && !closed) {
      // The host left: someone has to take over.
      reset();
      retry(300);
    }
  }

  /** Starts over after a pause, randomised so two people do not collide again. */
  const retry = (delay: number): void => {
    if (closed) {
      return;
    }
    clearTimeout(retryTimer);
    retryTimer = setTimeout(claim, delay + Math.random() * 1500) as unknown as number;
  };

  const wire = (link: DataConnection): void => {
    let opened = false;
    // A link that never opens means the direct connection failed; try again.
    const timeout = setTimeout(() => {
      if (!opened && !isHost) {
        setConn(`Room ${room}: could not reach the host, retrying...`, 'wait');
        reset();
        retry(2000);
      }
    }, 20000);

    link.on('open', () => {
      opened = true;
      clearTimeout(timeout);
      links.add(link);
      lastHeard.set(link, Date.now());
      report();
      if (!isHost) {
        link.send({ type: 'hello', from: ME } satisfies SyncMessage);
      }
    });
    link.on('data', (data) => {
      lastHeard.set(link, Date.now());
      if ((data as { type?: string })?.type === PING.type) {
        return;
      }
      const message = data as SyncMessage;
      if (isHost) {
        if (message?.type === 'hello') {
          // Only the host answers a newcomer, and only to them: otherwise
          // every join would send the whole project to everyone.
          onSync(message, (reply) => link.send(reply));
          return;
        }
        for (const other of links) {
          if (other !== link && other.open) {
            other.send(message);
          }
        }
      }
      onSync(message);
    });
    link.on('close', () => {
      clearTimeout(timeout);
      drop(link);
    });
  };

  /** Tries to become the host; if the room is already hosted, joins it. */
  function claim(): void {
    reset();
    isHost = false;
    const candidate = new Peer(hostId);
    peer = candidate;
    candidate.on('open', () => {
      if (peer === candidate) {
        isHost = true;
        report();
      }
    });
    candidate.on('connection', (link) => {
      if (peer === candidate) {
        wire(link);
      }
    });
    candidate.on('disconnected', () => {
      // Lost the introduction server, not the friends: links stay up.
      if (peer === candidate && !candidate.destroyed) {
        candidate.reconnect();
      }
    });
    candidate.on('error', (error: { type?: string }) => {
      if (peer !== candidate) {
        return;
      }
      if (error.type === 'unavailable-id') {
        join();
        return;
      }
      setConn(`Room ${room}: connection problem (${error.type ?? 'unknown'}), retrying...`, 'off');
      reset();
      retry(3000);
    });
  }

  function join(): void {
    peer?.destroy();
    isHost = false;
    const guest = new Peer();
    peer = guest;
    report();
    guest.on('open', () => {
      if (peer === guest) {
        wire(guest.connect(hostId, { reliable: true }));
      }
    });
    guest.on('disconnected', () => {
      if (peer === guest && !guest.destroyed) {
        guest.reconnect();
      }
    });
    guest.on('error', (error: { type?: string }) => {
      if (peer !== guest) {
        return;
      }
      // The address is held but nobody answers it: the host has just left and
      // the server has not noticed yet. Try for the address again shortly.
      if (error.type === 'peer-unavailable') {
        reset();
        retry(1000);
        return;
      }
      setConn(`Room ${room}: connection problem (${error.type ?? 'unknown'}), retrying...`, 'off');
      reset();
      retry(3000);
    });
  }

  claim();
  return {
    label: `room ${room}`,
    send: (message) => {
      for (const link of links) {
        if (link.open) {
          link.send(message);
        }
      }
    },
    close: () => {
      closed = true;
      clearTimeout(retryTimer);
      clearInterval(heartbeat);
      reset();
    },
  };
}

type Mode = 'tabs' | 'peer' | 'relay';

function connect(mode: Mode, room: string, relay: string): void {
  channel?.close();
  setConn('Not connected', 'off');
  try {
    channel =
      mode === 'relay' ? socketChannel(relay, room) : mode === 'peer' ? peerChannel(room) : tabsChannel(room);
  } catch (error) {
    setConn(`Could not connect: ${describe(error)}`, 'off');
    channel = undefined;
    return;
  }
  if (mode === 'tabs') {
    setConn(`Tabs in this browser (room ${room})`, 'on');
    channel.send({ type: 'hello', from: ME });
  }
}

/** Whether anything has been edited here since the page opened. */
let editedHere = false;
/** A joiner takes the first full state offered, and only the first. */
let adoptedState = false;

function onSync(message: SyncMessage, reply?: (message: SyncMessage) => void): void {
  if (!message || message.from === ME) {
    return;
  }
  switch (message.type) {
    case 'hello':
      (reply ?? ((m: SyncMessage) => channel?.send(m)))({
        type: 'state',
        from: ME,
        levels: store.levels,
        shared: store.shared,
        current: store.current,
        levelsEnabled: store.levelsEnabled,
      });
      return;

    case 'state':
      // Someone else's project replaces ours only if nothing has been done
      // here yet — joining is not a reason to lose work — or if they imported
      // a project on purpose.
      if (!message.force && (editedHere || adoptedState)) {
        return;
      }
      adoptedState = true;
      store = {
        levels: { ...message.levels },
        shared: { ...message.shared },
        current: message.current,
        levelsEnabled: message.levelsEnabled ?? Object.keys(message.levels).length > 1,
      };
      if (!(store.current in store.levels)) {
        store.current = levelNames()[0];
      }
      persist();
      applyLevelMode();
      renderLevels();
      loadLevel(store.current, { broadcast: false });
      return;

    case 'blocks':
      if (message.level === store.current) {
        sync.onRemoteChange(message.xml, Date.now());
        pump();
      } else {
        // Another level: nothing on screen to merge into, so keep it for later.
        store.levels[message.level] = message.xml;
        persist();
        renderLevels();
      }
      return;

    case 'files': {
      const files: ProjectText = {};
      for (const [name, content] of Object.entries(message.files)) {
        if (isShared(name)) {
          files[name] = content;
        }
      }
      store.shared = { ...store.shared, ...files };
      persist();
      // The editor reads images and extensions only when it loads a project,
      // so a new sprite from someone else needs the level reloaded to appear.
      reloadLevel();
      return;
    }

    case 'settings':
      store.levelsEnabled = message.levelsEnabled;
      persist();
      applyLevelMode();
      return;

    case 'level':
      if (message.level !== store.current) {
        loadLevel(message.level, { broadcast: false });
      }
      return;
  }
}

// ---------------------------------------------------------------------------
// The editor
// ---------------------------------------------------------------------------

const frame = document.getElementById('editor') as HTMLIFrameElement;

let project: ArcadeProject = buildProject();
let reach: EditorReach | undefined;
let pollTimer: number | undefined;
/** The workspace as last read, so only a real change is sent on. */
let lastPolled: string | undefined;
/** What both sides last agreed the blocks were, in the workspace's spelling. */
let agreed = '';
/**
 * Whether the editor has finished loading the current level. Until it has, its
 * workspace is empty or half-built and must never be saved — that would erase
 * the level. Proven by the workspace reaching the level's block count.
 */
let workspaceLoaded = false;
/** While set, the editor is reloading and what it reports is that reload. */
let settlingUntil = 0;
const SETTLE_MS = 2500;
const POLL_MS = 120;

let sync = new SyncState(DEFAULT_SYNC_OPTIONS);
let syncTimer: number | undefined;

function view(): any {
  return frame.contentWindow as any;
}

let editorStarted = false;

async function startEditor(): Promise<void> {
  editorStarted = true;
  showLoading('Loading the MakeCode Arcade editor…');
  // Never leave the loading screen up if the editor does not report back.
  setTimeout(hideLoading, 20000);
  try {
    frame.src = await createBlobEditorUrl(false);
  } catch (error) {
    showLoading(`Could not load MakeCode Arcade: ${describe(error)}`);
  }
}

window.addEventListener('message', (event: MessageEvent) => {
  if (event.source !== frame.contentWindow) {
    return;
  }
  const data = event.data as { type?: string } | undefined;

  // Ctrl+S inside the editor, forwarded by the shim.
  if (data?.type === 'blocksEditorSave') {
    clearTimeout(persistTimer);
    writeStore().then(() => setStatus('Saved'));
    return;
  }

  const outcome = handleEditorMessage(event.data, project);
  switch (outcome.kind) {
    case 'reply':
      view()?.postMessage(outcome.message, '*');
      return;

    case 'projectChanged': {
      // Images, tilemaps and extensions arrive here, never through the
      // workspace, so the shared files are taken from every report.
      const changed = changedFiles(store.shared, sharedFiles(outcome.project.text));
      if (Object.keys(changed).length) {
        store.shared = { ...store.shared, ...changed };
        persist();
        // Loading a level makes the editor re-save it, with its generated
        // files written slightly differently. Sending that would make everyone
        // else reload, re-save and send theirs back — a reload loop with nobody
        // editing. So while a level is still loading its files are kept here
        // quietly, and only a change made after it has loaded is shared.
        const loaded = workspaceLoaded || (!reach?.workspace && Date.now() >= settlingUntil);
        if (loaded) {
          editedHere = true;
          channel?.send({ type: 'files', from: ME, files: changed });
        }
      }
      // The blocks come from reading the workspace directly when it can be
      // reached; this report is only their fallback.
      if (!reach?.workspace && Date.now() >= settlingUntil) {
        const blocks = blocksOf(outcome.project);
        if (!(hasNoBlocks(blocks) && !hasNoBlocks(store.levels[store.current] ?? ''))) {
          localChange(blocks);
        }
      }
      return;
    }

    case 'status':
      probeOnce();
      if (!reach?.workspace) {
        watchForWorkspace();
      }
      return;

    case 'ignore':
      return;
  }
});

function probeOnce(): void {
  if (reach?.workspace) {
    return;
  }
  reach = probeEditor(frame);
  if (reach.sameOrigin) {
    listenForGame();
  }
  if (reach.sameOrigin && reach.workspace) {
    startPolling();
  }
}

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
 * Reads the workspace on a timer, rather than waiting for the editor to save.
 */
function startPolling(): void {
  if (pollTimer !== undefined) {
    return;
  }
  pollTimer = setInterval(() => {
    if (!reach || Date.now() < settlingUntil || isWorkspaceBusy(reach)) {
      return;
    }
    const blocks = readBlocksDirectly(reach, view());
    if (!blocks) {
      return;
    }
    if (!workspaceLoaded) {
      if (countBlocks(blocks) >= countBlocks(store.levels[store.current] ?? '')) {
        workspaceLoaded = true;
        agreed = blocks;
        lastPolled = blocks;
        hideLoading();
      }
      return;
    }
    if (blocks !== lastPolled) {
      lastPolled = blocks;
      localChange(blocks);
    }
  }, POLL_MS) as unknown as number;
}

function localChange(blocks: string): void {
  store.levels[store.current] = blocks;
  editedHere = true;
  persist();
  sync.onLocalChange(blocks, Date.now());
  pump();
}

/** Runs what the sync rules decide: send ours, or take theirs. */
function pump(): void {
  clearTimeout(syncTimer);
  const effect = sync.next(Date.now());
  if (!effect) {
    return;
  }
  switch (effect.kind) {
    case 'broadcast':
      channel?.send({ type: 'blocks', from: ME, level: store.current, xml: effect.blocks });
      agreed = (reach?.workspace && readBlocksDirectly(reach, view())) || effect.blocks;
      pump();
      return;
    case 'apply':
      applyRemote(effect.blocks);
      pump();
      return;
    case 'wait':
      syncTimer = setTimeout(pump, Math.max(50, effect.untilMs - Date.now())) as unknown as number;
      return;
  }
}

let deferred: string | undefined;

/** Puts someone else's blocks into the editor, block by block. */
function applyRemote(blocks: string): void {
  // Never while a block is in the user's hand; the drag ends and it lands.
  if (reach && isWorkspaceBusy(reach)) {
    const retry = deferred === undefined;
    deferred = blocks;
    if (retry) {
      setTimeout(() => {
        const pending = deferred;
        deferred = undefined;
        if (pending !== undefined) {
          applyRemote(pending);
        }
      }, POLL_MS);
    }
    return;
  }

  store.levels[store.current] = blocks;
  persist();

  if (!reach?.workspace) {
    reloadLevel();
    return;
  }

  const current = readBlocksDirectly(reach, view());
  if (current && sameBlocks(blocks, current)) {
    lastPolled = current;
    return;
  }

  const applied = applyBlocksDirectly(reach, view(), blocks, baseIndexOf(agreed));
  if (applied.mode === 'import') {
    reloadLevel();
    return;
  }
  const readback = readBlocksDirectly(reach, view()) ?? blocks;
  lastPolled = readback;
  agreed = readback;
  restartSimulatorSoon();
  highlightBlocks(reach, view(), applied.touched);
}

let simTimer: number | undefined;

/** The game picks up the new blocks once changes stop arriving. */
function restartSimulatorSoon(): void {
  clearTimeout(simTimer);
  simTimer = setTimeout(
    () => view()?.postMessage(editorCommand('restartsimulator'), '*'),
    700
  ) as unknown as number;
}

// ---------------------------------------------------------------------------
// Levels
// ---------------------------------------------------------------------------

/**
 * Puts a level in the editor. Only one level is ever loaded, so a game too big
 * to hold at once can still be played: the previous level is gone from memory
 * once the next has replaced it.
 */
function loadLevel(name: string, options: { broadcast?: boolean } = {}): void {
  if (!(name in store.levels)) {
    store.levels[name] = EMPTY_LEVEL;
  }
  store.current = name;
  persist();
  renderLevels();
  if (options.broadcast !== false) {
    channel?.send({ type: 'level', from: ME, level: name });
  }
  showLoading(`Loading ${name}…`);
  reloadLevel();
}

let importTimer: number | undefined;

/**
 * Hands the editor the current level afresh, and guards it while it loads.
 *
 * A load still in progress is never interrupted. Handing MakeCode a project
 * while it is still loading or compiling the last one trips errors inside its
 * own loader and compiler — which happens easily when several people follow a
 * level change at once, or someone joins mid-switch. So a second load waits
 * for the first to settle, and several in quick succession become one load of
 * whatever is current by then.
 */
function reloadLevel(): void {
  // A restart queued for the old level would run its program again.
  clearTimeout(simTimer);
  sync = new SyncState(DEFAULT_SYNC_OPTIONS);
  clearTimeout(syncTimer);
  lastPolled = undefined;
  agreed = '';
  workspaceLoaded = false;
  project = buildProject();

  clearTimeout(importTimer);
  const busyFor = settlingUntil - Date.now();
  if (busyFor > 0) {
    // Keep the poll paused until the deferred load has actually been sent.
    settlingUntil += 250;
    importTimer = setTimeout(sendImport, busyFor) as unknown as number;
  } else {
    sendImport();
  }
}

function sendImport(): void {
  project = buildProject();
  settlingUntil = Date.now() + SETTLE_MS;
  view()?.postMessage(importProjectMessage(project), '*');
  // Never leave the loading screen up if the editor does not report back.
  setTimeout(hideLoading, 15000);
}

function nextLevel(): string | undefined {
  const names = levelNames();
  return names[names.indexOf(store.current) + 1];
}

let listeningForGame = false;
let lastGameSignal = 0;

/**
 * Lets the running game ask for another level.
 *
 * The simulator posts its console output to the editor's window, and being
 * same-origin with the editor we can listen there. So a game signals with an
 * ordinary "console log" block:
 *
 *   console log "@next"          → the next level
 *   console log "@level level4"  → a particular level
 *
 * Philip's cutscene plays in the game first; the log at its end is what loads
 * the next level.
 */
function listenForGame(): void {
  const editorWindow = view();
  if (listeningForGame || !editorWindow) {
    return;
  }
  listeningForGame = true;
  editorWindow.addEventListener('message', (event: MessageEvent) => {
    const text = gameText(event.data);
    if (!text) {
      return;
    }
    if (!store.levelsEnabled) {
      return;
    }
    // While a level is loading, the game still running is the level being
    // left, and its signal was already acted on. Counting it again would skip
    // a level: "next" is worked out from the level now loading.
    if (!workspaceLoaded || Date.now() < settlingUntil) {
      return;
    }
    for (const line of text.split(/\r?\n/)) {
      const named = /^\s*@level\s+(\S+)/i.exec(line);
      const next = /^\s*@next\b/i.test(line);
      if (!named && !next) {
        continue;
      }
      // A log inside a loop repeats; one switch per signal.
      if (Date.now() - lastGameSignal < 3000) {
        return;
      }
      lastGameSignal = Date.now();
      const target = named ? named[1] : nextLevel();
      if (!target) {
        setStatus('That was the last level');
        return;
      }
      loadLevel(target);
      return;
    }
  });
}

/**
 * The text a simulator message carries, if it is console output.
 *
 * The simulator batches its console output: what arrives is `bulkserial`, an
 * array of `{ time, data }` lines, and only older builds send one `serial`
 * message per line. Both are read, so the signal works whichever arrives.
 */
function gameText(data: any): string | undefined {
  if (data?.type === 'bulkserial' && Array.isArray(data.data)) {
    return data.data
      .map((entry: any) => (typeof entry?.data === 'string' ? entry.data : ''))
      .join('');
  }
  if (data?.type === 'serial' && typeof data.data === 'string') {
    return data.data;
  }
  if (data?.type === 'messagepacket' && data.data instanceof Uint8Array) {
    return new TextDecoder().decode(data.data);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Import and export
// ---------------------------------------------------------------------------

/** Files that are never text, and would be corrupted by being read as text. */
const BINARY = /\.(png|jpe?g|gif|bmp|ico|uf2|hex|zip|mkcd|wav|mp3|ogg)$/i;

/**
 * Takes a project folder: each .blocks becomes a level named after its file,
 * and everything else beside them is shared by every level.
 */
async function importFolder(files: FileList): Promise<void> {
  const levels: Levels = {};
  const shared: ProjectText = {};
  for (const file of Array.from(files)) {
    const path = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
    // Only the folder itself; a subfolder is not part of the project.
    if (path.split('/').length > 2 || BINARY.test(file.name)) {
      continue;
    }
    const text = await file.text();
    if (file.name.endsWith('.blocks')) {
      levels[file.name.replace(/\.blocks$/, '')] = text;
    } else if (isShared(file.name)) {
      shared[file.name] = text;
    }
  }
  if (!Object.keys(levels).length) {
    setStatus('No .blocks files in that folder');
    return;
  }
  replaceProject(levels, shared);
}

async function importBackup(file: File): Promise<void> {
  try {
    const data = JSON.parse(await file.text()) as Partial<Store>;
    if (!data.levels || typeof data.levels !== 'object') {
      throw new Error('not an Arcade Collab backup');
    }
    replaceProject(data.levels, data.shared ?? {});
  } catch (error) {
    setStatus(`Could not open backup: ${describe(error)}`);
  }
}

function replaceProject(levels: Levels, shared: ProjectText): void {
  if (!window.confirm('Replace the current project with this one, for everyone connected?')) {
    return;
  }
  const names = Object.keys(levels).sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
  );
  store = {
    levels,
    shared,
    current: 'level1' in levels ? 'level1' : names[0],
    levelsEnabled: names.length > 1,
  };
  editedHere = true;
  persist();
  pushStateToEveryone();
  applyLevelMode();
  if (editorStarted) {
    loadLevel(store.current, { broadcast: false });
  } else {
    project = buildProject();
  }
  renderSetup();
}

/** Replaces everyone's project with ours: an import or a fresh start. */
function pushStateToEveryone(): void {
  channel?.send({
    type: 'state',
    from: ME,
    levels: store.levels,
    shared: store.shared,
    current: store.current,
    levelsEnabled: store.levelsEnabled,
    force: true,
  });
}

function exportBackup(): void {
  const blob = new Blob([JSON.stringify(store)], { type: 'application/json' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = 'arcade-collab-backup.json';
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 10000);
}

// ---------------------------------------------------------------------------
// The page around the editor
// ---------------------------------------------------------------------------

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const levelSelect = el<HTMLSelectElement>('level');
const levelControls = el<HTMLSpanElement>('level-controls');
const statusEl = el<HTMLSpanElement>('status');
const loadingEl = el<HTMLDivElement>('loading');
const loadingText = el<HTMLDivElement>('loading-text');
const folderInput = el<HTMLInputElement>('folder-input');
const backupInput = el<HTMLInputElement>('backup-input');

function renderLevels(): void {
  levelSelect.replaceChildren(
    ...levelNames().map((name) => {
      const option = document.createElement('option');
      option.value = name;
      option.textContent = name;
      option.selected = name === store.current;
      return option;
    })
  );
}

/** Shows or hides everything to do with levels, to match the switch. */
function applyLevelMode(): void {
  levelControls.hidden = !store.levelsEnabled;
  renderLevels();
}

function setStatus(text: string): void {
  statusEl.textContent = text;
}

const connEl = el<HTMLSpanElement>('conn');

/** The connection, shown apart from save messages so it is never hidden by them. */
function setConn(text: string, state: 'on' | 'wait' | 'off'): void {
  connEl.textContent = text;
  connEl.className = `conn ${state}`;
}

function showLoading(text: string): void {
  loadingText.textContent = text;
  loadingEl.hidden = false;
}

function hideLoading(): void {
  loadingEl.hidden = true;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

levelSelect.addEventListener('change', () => loadLevel(levelSelect.value));

el('add-level').addEventListener('click', () => {
  let n = levelNames().length + 1;
  while (`level${n}` in store.levels) {
    n++;
  }
  loadLevel(`level${n}`);
});

el('export').addEventListener('click', exportBackup);

folderInput.addEventListener('change', () => {
  if (folderInput.files?.length) {
    void importFolder(folderInput.files);
  }
  folderInput.value = '';
});

backupInput.addEventListener('change', () => {
  const file = backupInput.files?.[0];
  if (file) {
    void importBackup(file);
  }
  backupInput.value = '';
});

// ---------------------------------------------------------------------------
// Setup: shown before the editor loads, and again from the ⚙ button
// ---------------------------------------------------------------------------

const setupEl = el<HTMLDivElement>('setup');
const summaryEl = el<HTMLParagraphElement>('project-summary');
const levelsOn = el<HTMLInputElement>('levels-on');
const levelsDetail = el<HTMLDivElement>('levels-detail');
const countEl = el<HTMLSpanElement>('lv-count');
const chipsEl = el<HTMLDivElement>('lv-chips');
const relayInput = el<HTMLInputElement>('relay-url');
const roomInput = el<HTMLInputElement>('setup-room');
const roomHint = el<HTMLParagraphElement>('room-hint');
const startButton = el<HTMLButtonElement>('setup-start');

const MIN_LEVELS = 2;
const MAX_LEVELS = 50;

/** What the setup screen will apply when Start is pressed. */
const draft = { levelCount: 10 };

function remembered(key: string, fallback: string): string {
  try {
    return localStorage.getItem(`arcade-collab:${key}`) ?? fallback;
  } catch {
    return fallback;
  }
}

function remember(key: string, value: string): void {
  try {
    localStorage.setItem(`arcade-collab:${key}`, value);
  } catch {
    // Remembering it is a convenience.
  }
}

function selectedMode(): Mode {
  const value = document.querySelector<HTMLInputElement>('input[name="mode"]:checked')?.value;
  return value === 'relay' || value === 'tabs' ? value : 'peer';
}

/**
 * A fresh room code. On PeerJS's public server a room is open to anyone who
 * types its name, so the default is one nobody else will happen to pick.
 */
function randomRoom(): string {
  const letters = 'abcdefghjkmnpqrstuvwxyz23456789';
  let code = 'arcade-';
  for (let i = 0; i < 6; i++) {
    code += letters[Math.floor(Math.random() * letters.length)];
  }
  return code;
}

/** The connection in use, so Apply reconnects only when something changed. */
let activeConnection = '';

function openSetup(): void {
  levelsOn.checked = store.levelsEnabled;
  draft.levelCount = Math.max(MIN_LEVELS, Math.min(MAX_LEVELS, levelNames().length > 1 ? levelNames().length : 10));
  relayInput.value = remembered('relay', '');
  roomInput.value = remembered('room', '') || randomRoom();
  const mode = remembered('mode', 'peer');
  for (const radio of document.querySelectorAll<HTMLInputElement>('input[name="mode"]')) {
    radio.checked = radio.value === mode;
  }
  startButton.textContent = editorStarted ? 'Apply' : 'Start editing →';
  renderSetup();
  setupEl.hidden = false;
}

/** Redraws the setup screen from the project and the choices so far. */
function renderSetup(): void {
  const names = levelNames();
  const edited = names.some((name) => store.levels[name] !== EMPTY_LEVEL);
  summaryEl.textContent = edited
    ? `Your saved project has ${names.length} level${names.length === 1 ? '' : 's'}: ${names.join(', ')}.`
    : 'A new, empty project.';

  levelsDetail.hidden = !levelsOn.checked;
  countEl.textContent = String(draft.levelCount);
  chipsEl.replaceChildren(
    ...Array.from({ length: draft.levelCount }, (_, i) => {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.textContent = `L${i + 1}`;
      if (i === 0) {
        chip.classList.add('first');
        chip.title = 'Loaded first';
      }
      return chip;
    })
  );
  relayInput.hidden = selectedMode() !== 'relay';
  roomHint.textContent =
    selectedMode() === 'peer'
      ? 'Give this code to your friends. Everyone who types the same code is in the same game, up to everyone in your group.'
      : 'Everyone who uses the same room name edits together.';
}

levelsOn.addEventListener('change', renderSetup);
for (const radio of document.querySelectorAll<HTMLInputElement>('input[name="mode"]')) {
  radio.addEventListener('change', renderSetup);
}
el('new-room').addEventListener('click', () => {
  roomInput.value = randomRoom();
});
el('lv-minus').addEventListener('click', () => {
  draft.levelCount = Math.max(MIN_LEVELS, draft.levelCount - 1);
  renderSetup();
});
el('lv-plus').addEventListener('click', () => {
  draft.levelCount = Math.min(MAX_LEVELS, draft.levelCount + 1);
  renderSetup();
});

el('setup-new').addEventListener('click', () => {
  const edited = levelNames().some((name) => store.levels[name] !== EMPTY_LEVEL);
  if (
    edited &&
    !window.confirm(
      'Start a new, empty project? The saved one is replaced, for everyone connected — Export it first to keep a copy.'
    )
  ) {
    return;
  }
  store = { levels: { level1: EMPTY_LEVEL }, shared: {}, current: 'level1', levelsEnabled: levelsOn.checked };
  editedHere = true;
  persist();
  pushStateToEveryone();
  if (editorStarted) {
    loadLevel('level1', { broadcast: false });
  } else {
    project = buildProject();
  }
  renderSetup();
});
el('setup-import').addEventListener('click', () => folderInput.click());
el('setup-backup').addEventListener('click', () => backupInput.click());

el('open-setup').addEventListener('click', openSetup);

startButton.addEventListener('click', () => {
  // Levels: switching on makes sure level1 … levelN exist. Nothing is ever
  // deleted — a level beyond the count, or every level but the current one
  // when switching off, is kept for when it is wanted again.
  const wasEnabled = store.levelsEnabled;
  store.levelsEnabled = levelsOn.checked;
  if (store.levelsEnabled) {
    for (let n = 1; n <= draft.levelCount; n++) {
      store.levels[`level${n}`] ??= EMPTY_LEVEL;
    }
  }
  if (!(store.current in store.levels)) {
    store.current = levelNames()[0];
  }
  persist();
  applyLevelMode();
  if (wasEnabled !== store.levelsEnabled) {
    channel?.send({ type: 'settings', from: ME, levelsEnabled: store.levelsEnabled });
  }

  // Connection: only reconnected if something about it changed.
  const mode = selectedMode();
  const relay = relayInput.value.trim();
  const room = (mode === 'peer' ? peerRoom(roomInput.value) : roomInput.value.trim()) || 'arcade';
  roomInput.value = room;
  if (mode === 'relay' && !relay) {
    relayInput.focus();
    return;
  }
  const key = `${mode}|${room}|${mode === 'relay' ? relay : ''}`;
  if (!channel || key !== activeConnection) {
    connect(mode, room, relay);
    activeConnection = key;
  }
  remember('mode', mode);
  remember('relay', relay);
  remember('room', room);

  setupEl.hidden = true;
  if (!editorStarted) {
    project = buildProject();
    void startEditor();
  }
});

// ---------------------------------------------------------------------------
// Start: the setup screen first; the editor loads when it is done
// ---------------------------------------------------------------------------

void (async () => {
  const saved = await loadStore();
  if (saved?.levels && Object.keys(saved.levels).length) {
    store = {
      ...saved,
      // Projects saved before levels could be switched off: on if they have them.
      levelsEnabled: saved.levelsEnabled ?? Object.keys(saved.levels).length > 1,
    };
    if (!(store.current in store.levels)) {
      store.current = levelNames()[0];
    }
  }
  project = buildProject();
  applyLevelMode();
  openSetup();
})();
