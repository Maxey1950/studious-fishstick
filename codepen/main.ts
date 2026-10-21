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
  applyFilesLive,
  baseIndexOf,
  createBlobEditorUrl,
  highlightBlocks,
  isWorkspaceBusy,
  probeEditor,
  readBlocksDirectly,
  replaceBlocks,
  runLatestGame,
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
/**
 * Which load of the editor this is.
 *
 * Stamped on the project's header, which the editor hands back on every save.
 * A save carrying an older stamp is from the project the editor had before the
 * latest load reached it, and says nothing about what is there now.
 */
let loadToken = 0;

// How many times the editor has been handed a whole project since it started:
// type arcadeCollabLoads in the console to see that editing, levels, sprites
// and joining are not reloading it.
Object.defineProperty(window, 'arcadeCollabLoads', { get: () => loadToken });

/**
 * The blocks in the project last handed to the editor. A change that arrives
 * while it is loading is not in them, and goes in once it has loaded.
 */
let givenBlocks = EMPTY_LEVEL;

function buildProject(): ArcadeProject {
  givenBlocks = store.levels[store.current] ?? EMPTY_LEVEL;
  const level = createProject(store.current, givenBlocks);
  level.header.collabLoad = loadToken;
  return withFiles(level, store.shared);
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
  // Someone who joined a room is editing the host's project, and the host
  // keeps it. Saving it here too would put a second, older copy of it on this
  // computer — and replace whatever project of their own they had saved.
  if (role === 'join') {
    return;
  }
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
  /** Someone opened this level, so it exists; nobody else moves. */
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
function peerChannel(roomName: string, hosting: boolean): Channel {
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
  //
  // The limit is generous. Chrome slows the timers of a tab in the background
  // — to once a minute after a few minutes — and a busy game can hold up a
  // page for seconds; with a short limit, both looked like leaving, and people
  // were kicked out at random. Someone who really leaves closes their links as
  // the page goes (below), which is noticed at once.
  const PING = { type: '__ping' } as const;
  const PING_MS = 2000;
  const SILENT_MS = 75000;
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
      setConn(others ? `Room ${room}: joined the host` : `Room ${room}: joining...`, others ? 'on' : 'wait');
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
      // The host left. Only the host has the project, so nobody takes over:
      // wait for them to come back, and stop editing a copy that would be lost.
      setConn(`Room ${room}: the host left, waiting for them to come back`, 'off');
      hostLeft();
      reset();
      retry(2000);
    }
  }

  /** Starts over after a pause, randomised so two people do not collide again. */
  const retry = (delay: number): void => {
    if (closed) {
      return;
    }
    clearTimeout(retryTimer);
    retryTimer = setTimeout(hosting ? claim : join, delay + Math.random() * 1500) as unknown as number;
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
        // Someone else is hosting this code — or this page was just reloaded
        // and the server still holds the old one for a few seconds.
        setConn(`Room ${room} already has a host. Choose "Join", or a new code. Retrying...`, 'off');
        reset();
        retry(5000);
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
      // Nobody is hosting this code yet, or the host has just left.
      if (error.type === 'peer-unavailable') {
        setConn(`Room ${room}: waiting for the host to open it...`, 'wait');
        reset();
        retry(2000);
        return;
      }
      setConn(`Room ${room}: connection problem (${error.type ?? 'unknown'}), retrying...`, 'off');
      reset();
      retry(3000);
    });
  }

  if (hosting) {
    claim();
  } else {
    join();
  }
  // Leaving closes the links, so the others know straight away.
  const leave = (): void => reset();
  window.addEventListener('pagehide', leave);
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
      window.removeEventListener('pagehide', leave);
      reset();
    },
  };
}

type Mode = 'tabs' | 'host' | 'join' | 'relay';

/**
 * Hosting a room means the project is yours: you keep it and everyone else
 * edits it. Joining means editing the host's, and keeping nothing.
 */
let role: Mode | undefined;

function connect(mode: Mode, room: string, relay: string): void {
  channel?.close();
  role = mode;
  setConn('Not connected', 'off');
  if (mode === 'join') {
    waitForHost(`Getting the project from room ${room}'s host\u2026`);
  }
  try {
    channel =
      mode === 'relay'
        ? socketChannel(relay, room)
        : mode === 'host' || mode === 'join'
          ? peerChannel(room, mode === 'host')
          : tabsChannel(room);
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
      // In a room, it is simple: whoever joined takes the host's project, every
      // time they connect, and the host takes nobody's — unless someone opened
      // a project for everyone on purpose.
      if (role === 'join') {
        waitingForHost = false;
      } else if (role === 'host' ? !message.force : !message.force && (editedHere || adoptedState)) {
        return;
      }
      // Joining for the first time lands on the host's level; after that,
      // everyone is on a level of their own and rejoining moves nobody.
      const firstJoin = role === 'join' && !editorStarted;
      adoptedState = true;
      store = {
        levels: { ...message.levels },
        shared: withOwnEditor(message.shared, store.shared),
        current: !firstJoin && store.current in message.levels ? store.current : message.current,
        levelsEnabled: message.levelsEnabled ?? Object.keys(message.levels).length > 1,
      };
      if (!(store.current in store.levels)) {
        store.current = levelNames()[0];
      }
      persist();
      applyLevelMode();
      renderLevels();
      void showProject();
      return;

    case 'blocks':
      // Someone who joined takes the host's whole project before anything
      // else; it already has this change in it.
      if (waitingForHost) {
        return;
      }
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
      // Code made from the blocks is never loaded from someone else: the
      // blocks arrive live, and every editor writes its own.
      const files: ProjectText = {};
      for (const [name, content] of Object.entries(message.files)) {
        if (isShared(name) && !FROM_BLOCKS.has(name)) {
          files[name] = content;
        }
      }
      if (!Object.keys(files).length) {
        return;
      }
      const theirs = withOwnEditor(files, store.shared);
      store.shared = { ...store.shared, ...theirs };
      incoming = { ...incoming, ...theirs };
      persist();
      // One sprite arrives as several messages — its images, then the code
      // made from them — so wait for the rest and put them in together.
      clearTimeout(idleReloadTimer);
      idleReloadTimer = setTimeout(addIncomingFiles, GATHER_MS) as unknown as number;
      return;
    }

    case 'settings':
      store.levelsEnabled = message.levelsEnabled;
      persist();
      applyLevelMode();
      return;

    case 'level':
      // Someone opened a level. Everyone can see it exists, but stays on
      // their own: following each other between levels was never wanted.
      if (!(message.level in store.levels)) {
        store.levels[message.level] = EMPTY_LEVEL;
        persist();
        renderLevels();
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
/**
 * Files from someone else that are waiting for the editor to be reloaded.
 *
 * Until it is, the editor keeps saving the project it already has, and those
 * saves carry the old images. Taken at their word they overwrote the new ones
 * before the reload could show them, so a sprite drawn on one computer never
 * appeared on the others. They win over anything the editor reports until the
 * reload is sent; after that, the load's stamp tells old saves apart.
 */
let incoming: ProjectText = {};
/** Files the editor writes from the blocks, which reach everyone as blocks. */
const FROM_BLOCKS = new Set(['main.ts', 'main.py']);
/** When this person last changed the blocks. */
let lastLocalEdit = 0;
/**
 * Whether this person has changed the blocks since they last sent them. A drop
 * picked up by the poll just as someone else's change comes in is held back by
 * the sync rules, and merging theirs must not forget it.
 */
let editedSinceSent = false;
let idleReloadTimer: number | undefined;
/** Never cut into someone's drag, or the image editor, for a reload. */
const IDLE_MS = 1500;
const GATHER_MS = 600;
const MAX_WAIT_MS = 20000;
const POLL_MS = 1500;
/** How often a pending drop or retry is looked at again. */
const RETRY_MS = 120;

let sync = new SyncState(DEFAULT_SYNC_OPTIONS);
let syncTimer: number | undefined;

function view(): any {
  return frame.contentWindow as any;
}

let editorStarted = false;

async function startEditor(): Promise<void> {
  editorStarted = true;
  if (!waitingForHost) {
    showLoading('Loading the MakeCode Arcade editor…');
  }
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
    if (role === 'join') {
      setStatus('The host keeps this project');
      return;
    }
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
      // A save from an earlier load of ours is the old project, still being
      // written out. One with no stamp at all is a project the editor made
      // itself — its own Import, of a .png or .mkcd — and is real.
      const token = outcome.project.header?.collabLoad;
      if ((token !== undefined && token !== loadToken) || importWhenReady || waitingForHost) {
        return;
      }
      // Images, tilemaps and extensions arrive here, never through the
      // workspace, so the shared files are taken from every report.
      const reported = sharedFiles(outcome.project.text);
      // While a friend's files wait for a drag to finish, the editor is still
      // saving its own older ones.
      for (const name of Object.keys(incoming)) {
        delete reported[name];
      }
      const changed = changedFiles(store.shared, reported);
      if (Object.keys(changed).length) {
        const previous = store.shared;
        store.shared = { ...store.shared, ...changed };
        persist();
        // Every block dragged rewrites main.ts. Sending it made everyone else
        // reload the whole editor on every change, mid-drag; the blocks
        // themselves already travel live, so it is kept here and not sent.
        for (const name of FROM_BLOCKS) {
          delete changed[name];
        }
        // Nor is pxt.json touched up by the editor in ways nobody would see.
        if ('pxt.json' in changed && samePxtJson(previous['pxt.json'], changed['pxt.json'])) {
          delete changed['pxt.json'];
        }
      }
      if (Object.keys(changed).length) {
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
      if (!editorReady) {
        editorReady = true;
        if (importWhenReady) {
          // "Loaded" comes just before the editor will take another project;
          // one sent at once is dropped.
          setTimeout(() => {
            importWhenReady = false;
            reloadLevel();
          }, READY_SETTLE_MS);
        }
      }
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
 * Reads the workspace when it changes, rather than waiting for the editor to
 * save.
 *
 * Reading it means writing the whole of it out as text, and a big game is a
 * lot of text: doing that eight times a second, whether anything had changed
 * or not, was steady work for a computer already running the game. Blockly
 * says when a block changes, and a read follows that; the timer stays only as
 * a slow backstop for anything that changes without saying so.
 */
function startPolling(): void {
  if (pollTimer !== undefined) {
    return;
  }
  pollTimer = setInterval(readWorkspace, POLL_MS) as unknown as number;
}

/** Workspaces already being listened to; the editor makes a new one on a load. */
const listening = new WeakSet<object>();
let readTimer: number | undefined;
const READ_AFTER_MS = 60;

function listenToWorkspace(): void {
  const workspace = reach?.workspace;
  if (!workspace || listening.has(workspace) || typeof workspace.addChangeListener !== 'function') {
    return;
  }
  listening.add(workspace);
  workspace.addChangeListener((event: { isUiEvent?: boolean }) => {
    // Selecting, scrolling and opening the toolbox change nothing.
    if (event?.isUiEvent) {
      return;
    }
    clearTimeout(readTimer);
    readTimer = setTimeout(readWorkspace, READ_AFTER_MS) as unknown as number;
  });
}

function readWorkspace(): void {
  // Not while a load is under way or waits for the editor to start, or while
  // someone who joined waits for the host's project: what is on screen is
  // the project being replaced, and sending it would undo the one that
  // counts. Nor with a block in hand: it is read when it is put down.
  if (!reach || Date.now() < settlingUntil || importWhenReady || waitingForHost || isWorkspaceBusy(reach)) {
    return;
  }
  const blocks = readBlocksDirectly(reach, view());
  // Reading finds the live workspace, which a load replaces.
  listenToWorkspace();
  if (!blocks) {
    return;
  }
  if (!workspaceLoaded) {
    if (countBlocks(blocks) >= countBlocks(givenBlocks)) {
      workspaceLoaded = true;
      agreed = blocks;
      lastPolled = blocks;
      hideLoading();
      // Changes that came in while it loaded.
      const latest = store.levels[store.current];
      if (latest && !sameBlocks(latest, givenBlocks)) {
        applyRemote(latest);
      }
    }
    return;
  }
  if (blocks !== lastPolled) {
    lastPolled = blocks;
    localChange(blocks);
  }
}

function localChange(blocks: string): void {
  // MakeCode restarts the game itself after a change made here, and that run
  // has everyone's changes in it.
  updateGameButton.hidden = true;
  lastLocalEdit = Date.now();
  editedSinceSent = true;
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
      editedSinceSent = false;
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
      }, RETRY_MS);
    }
    return;
  }

  store.levels[store.current] = blocks;
  persist();

  // The editor is still starting or loading. It is kept in the store, and
  // goes in when the load is done — no second load for it.
  if (!reach?.workspace || !workspaceLoaded) {
    return;
  }

  const current = readBlocksDirectly(reach, view());
  if (current && sameBlocks(blocks, current)) {
    lastPolled = current;
    return;
  }
  // A change made here that the poll has not picked up yet — a block dropped
  // while theirs was waiting for the drag to end.
  const unsent =
    workspaceLoaded && ((current !== undefined && current !== lastPolled) || editedSinceSent);

  const applied = applyBlocksDirectly(reach, view(), blocks, baseIndexOf(agreed));
  if (applied.mode === 'import') {
    reloadLevel();
    return;
  }
  const readback = readBlocksDirectly(reach, view()) ?? blocks;
  lastPolled = readback;
  agreed = readback;
  gameOutOfDate();
  highlightBlocks(reach, view(), applied.touched);
  // The merge kept that change, and reading back already includes it, so the
  // poll would never see it as new: send it now.
  if (unsent && !sameBlocks(readback, blocks)) {
    localChange(readback);
  }
}

let simTimer: number | undefined;

/**
 * Someone else changed the code the game is running.
 *
 * Their changes go into the blocks with the editor's events switched off, so
 * MakeCode does not restart the game for them — and restarting it here for
 * every change anyone made restarted everyone's game, over and over, which is
 * the lag you feel while playing. The game keeps running; a button offers the
 * new version when you want it.
 */
function gameOutOfDate(): void {
  updateGameButton.hidden = false;
}

/** The game picks up the new blocks once changes stop arriving. */
function restartSimulatorSoon(): void {
  clearTimeout(simTimer);
  simTimer = setTimeout(restartGame, 700) as unknown as number;
}

/** Runs the game again, from the blocks on the canvas now. */
function restartGame(): void {
  runLatestGame(view()).then(
    (ran) => {
      if (!ran) {
        view()?.postMessage(editorCommand('restartsimulator'), '*');
      }
    },
    () => view()?.postMessage(editorCommand('restartsimulator'), '*')
  );
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
  // The level being left keeps its last change, and everyone has it.
  sendUnsentChange();
  if (!(name in store.levels)) {
    store.levels[name] = EMPTY_LEVEL;
  }
  store.current = name;
  persist();
  renderLevels();
  if (options.broadcast !== false) {
    channel?.send({ type: 'level', from: ME, level: name });
  }
  if (showLevelLive()) {
    return;
  }
  showLoading(`Loading ${name}…`);
  reloadLevel();
}

/**
 * Sends this level's blocks now if a change to them has not gone out yet:
 * one the poll has not read, or one the sync rules were holding back. Moving
 * to another level starts the sync over, and it would be lost.
 */
function sendUnsentChange(): void {
  flushLocalChange();
  if (editedSinceSent && workspaceLoaded) {
    channel?.send({ type: 'blocks', from: ME, level: store.current, xml: store.levels[store.current] });
    editedSinceSent = false;
  }
}

/**
 * Shows the current level by swapping the blocks on the canvas, with no
 * reload: the editor, its toolbox and the person's place in it stay put, and
 * the game restarts on the new level. All levels share their images, so the
 * blocks are all that changes. False if it cannot be done; then load it.
 */
function showLevelLive(): boolean {
  if (!reach?.workspace || !workspaceLoaded || importWhenReady || Date.now() < settlingUntil) {
    return false;
  }
  const blocks = store.levels[store.current] ?? EMPTY_LEVEL;
  if (!replaceBlocks(reach, view(), blocks)) {
    return false;
  }
  clearTimeout(syncTimer);
  sync = new SyncState(DEFAULT_SYNC_OPTIONS);
  editedSinceSent = false;
  const readback = readBlocksDirectly(reach, view()) ?? blocks;
  lastPolled = readback;
  agreed = readback;
  // The game still running is the level being left: anything it signals in
  // the moment before it restarts is not about this one.
  lastGameSignal = Date.now();
  updateGameButton.hidden = true;
  restartSimulatorSoon();
  return true;
}

/**
 * Shows a whole project that arrived from someone else — the host's, on
 * joining or rejoining, or one opened for everyone — in the running editor.
 *
 * Images first, so the blocks that use them have them to draw. Someone who
 * joined has no editor yet the first time: it starts now, with the host's
 * project, instead of starting with their own and reloading into the host's.
 */
async function showProject(): Promise<void> {
  if (!editorStarted) {
    if (role === 'join') {
      project = buildProject();
      void startEditor();
    }
    return;
  }
  incoming = Object.fromEntries(Object.entries(store.shared).filter(([name]) => !FROM_BLOCKS.has(name)));
  const ready = reach?.workspace && workspaceLoaded && !importWhenReady && Date.now() >= settlingUntil;
  if (ready && (await applyFilesLive(view(), incoming)) === 'applied') {
    incoming = {};
    if (showLevelLive()) {
      return;
    }
  }
  showLoading(`Loading ${store.current}\u2026`);
  reloadLevel();
}

let importTimer: number | undefined;
/** Whether the editor has finished starting up and can be sent a project. */
let editorReady = false;
let importWhenReady = false;
const READY_SETTLE_MS = 1000;

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
  // This load picks up any files a pending reload was waiting to add.
  clearTimeout(idleReloadTimer);
  sync = new SyncState(DEFAULT_SYNC_OPTIONS);
  clearTimeout(syncTimer);
  lastPolled = undefined;
  agreed = '';
  workspaceLoaded = false;
  project = buildProject();

  clearTimeout(importTimer);
  if (!editorReady) {
    // Still starting up. A load sent now runs into the one already under way
    // and breaks the editor; it asks for the project itself, or gets this one
    // once it is ready.
    importWhenReady = true;
    return;
  }
  const busyFor = settlingUntil - Date.now();
  if (busyFor > 0) {
    // Keep the poll paused until the deferred load has actually been sent.
    settlingUntil += 250;
    importTimer = setTimeout(sendImport, busyFor) as unknown as number;
  } else {
    sendImport();
  }
}

/**
 * Whether two pxt.json files differ only where the editor writes on its own.
 *
 * The first save after a load adds `preferredEditor`, and the name follows the
 * level. Neither changes what anyone sees, and both used to reload everyone.
 */
function samePxtJson(a: string | undefined, b: string | undefined): boolean {
  try {
    const meaningful = (text: string) => {
      const { name, description, preferredEditor, ...rest } = JSON.parse(text);
      return JSON.stringify(rest);
    };
    return a !== undefined && b !== undefined && meaningful(a) === meaningful(b);
  } catch {
    return false;
  }
}

/**
 * Someone else's files, but with this person's choice of Blocks or JavaScript.
 *
 * The editor records which one is open in pxt.json, so a pxt.json from someone
 * else — sent with a new sprite, or on joining — switched everyone into
 * whichever editor its sender happened to have open.
 */
function withOwnEditor(files: ProjectText, own: ProjectText): ProjectText {
  if (!('pxt.json' in files)) {
    return { ...files };
  }
  try {
    const config = JSON.parse(files['pxt.json']);
    const mine = own['pxt.json'] ? JSON.parse(own['pxt.json']).preferredEditor : undefined;
    if (mine === undefined) {
      delete config.preferredEditor;
    } else {
      config.preferredEditor = mine;
    }
    return { ...files, 'pxt.json': JSON.stringify(config, null, 4) };
  } catch {
    return { ...files };
  }
}

/**
 * Puts a friend's new images into the running editor, with no reload.
 *
 * Waits for any load under way (it may already carry them, and is no place to
 * be writing files) and for a block in hand to be put down. Only an extension
 * cannot go in live; that still reloads, once the person pauses.
 */
async function addIncomingFiles(tries = 0): Promise<void> {
  clearTimeout(idleReloadTimer);
  const busy =
    !reach?.workspace ||
    !workspaceLoaded ||
    importWhenReady ||
    Date.now() < settlingUntil ||
    isWorkspaceBusy(reach);
  if (busy) {
    idleReloadTimer = setTimeout(() => addIncomingFiles(tries), 300) as unknown as number;
    return;
  }
  const adding = { ...incoming };
  if (!Object.keys(adding).length) {
    return;
  }
  const outcome = await applyFilesLive(view(), adding);
  if (outcome === 'applied') {
    for (const [name, content] of Object.entries(adding)) {
      if (incoming[name] === content) {
        delete incoming[name];
      }
    }
    gameOutOfDate();
    setStatus('Added new images from a friend');
  } else if (outcome === 'busy' && tries < LIVE_TRIES) {
    // The editor is in the middle of something — its own Import, say. Being
    // busy for a moment is no reason to reload it.
    idleReloadTimer = setTimeout(() => addIncomingFiles(tries + 1), 1000) as unknown as number;
  } else {
    reloadWhenIdle();
  }
}

const LIVE_TRIES = 8;

/**
 * Reloads the level once this person is not in the middle of something.
 *
 * An extension from someone else cannot be added to a running editor, but the
 * reload can wait: not while a block is in hand, nor while the image editor is
 * open, nor within a moment of the last change made here.
 */
function reloadWhenIdle(since = Date.now()): void {
  clearTimeout(idleReloadTimer);
  const busy =
    (reach && isWorkspaceBusy(reach)) ||
    isFieldEditorOpen() ||
    Date.now() - lastLocalEdit < IDLE_MS;
  if (busy && Date.now() - since < MAX_WAIT_MS) {
    setStatus('A friend added an extension \u2014 reloading when you pause');
    idleReloadTimer = setTimeout(() => reloadWhenIdle(since), 300) as unknown as number;
    return;
  }
  if (reach && isWorkspaceBusy(reach)) {
    // Past the limit, but still never under a dragged block.
    idleReloadTimer = setTimeout(() => reloadWhenIdle(since), 300) as unknown as number;
    return;
  }
  if (flushLocalChange()) {
    // Something was just dropped: it is sent and kept, and the reload waits
    // for a pause after it like any other edit.
    idleReloadTimer = setTimeout(() => reloadWhenIdle(since), 300) as unknown as number;
    return;
  }
  showLoading('Adding an extension from a friend\u2026');
  reloadLevel();
}

/**
 * Takes in a change the poll has not reached yet, so a reload — which rebuilds
 * the editor from what is stored — cannot lose it. Whether there was one.
 */
function flushLocalChange(): boolean {
  if (!reach || !workspaceLoaded || Date.now() < settlingUntil) {
    return false;
  }
  const blocks = readBlocksDirectly(reach, view());
  if (!blocks || blocks === lastPolled) {
    return false;
  }
  lastPolled = blocks;
  localChange(blocks);
  return true;
}

function isFieldEditorOpen(): boolean {
  try {
    return Boolean(view()?.pxt?.react?.isFieldEditorViewVisible?.());
  } catch {
    return false;
  }
}

function sendImport(): void {
  loadToken++;
  project = buildProject();
  incoming = {};
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
  incoming = { ...shared };
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
const updateGameButton = el<HTMLButtonElement>('update-game');
updateGameButton.addEventListener('click', () => {
  updateGameButton.hidden = true;
  restartGame();
});
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
  if (waitingForHost) {
    return;
  }
  loadingEl.hidden = true;
}

/**
 * Whether someone who joined a room has nothing of the host's to edit yet —
 * before the host's project arrives, or while the host is away. The editor
 * stays covered: anything done there would be replaced when the host's
 * project comes.
 */
let waitingForHost = false;

function waitForHost(text: string): void {
  waitingForHost = true;
  showLoading(text);
}

function hostLeft(): void {
  waitForHost('The host left. Waiting for them to come back\u2026');
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
const newRoomButton = el<HTMLButtonElement>('new-room');
const ownProjectSections = [el<HTMLElement>('project-section'), el<HTMLElement>('levels-section')];

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
  return value === 'relay' || value === 'tabs' || value === 'join' ? value : 'host';
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
  // "peer" is what hosting was called before there was joining.
  const mode = role ?? remembered('mode', 'host').replace(/^peer$/, 'host');
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
  const mode = selectedMode();
  relayInput.hidden = mode !== 'relay';
  newRoomButton.hidden = mode === 'join';
  // Joining edits the host's project: this computer's own, and its levels,
  // are not what anyone will be working on.
  for (const section of ownProjectSections) {
    section.hidden = mode === 'join';
  }
  roomHint.textContent =
    mode === 'host'
      ? 'Your project. Give this code to your friends and they choose "Join". Only your computer keeps the project.'
      : mode === 'join'
        ? "Type the code your host gave you. You'll edit their project; nothing saved on this computer is changed."
        : 'Everyone who uses the same room name edits together.';
}

levelsOn.addEventListener('change', renderSetup);
for (const radio of document.querySelectorAll<HTMLInputElement>('input[name="mode"]')) {
  radio.addEventListener('change', renderSetup);
}
newRoomButton.addEventListener('click', () => {
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
  const mode = selectedMode();

  // Between hosting and joining, the project on screen changes owner: a
  // host's project must not be saved over this computer's, nor this
  // computer's sent to a room as if it were the host's. Start over cleanly.
  if (editorStarted && role !== undefined && (role === 'join') !== (mode === 'join')) {
    remember('mode', mode);
    remember('room', peerRoom(roomInput.value));
    location.reload();
    return;
  }

  // Levels belong to the project, so they are the host's to set.
  if (mode !== 'join') {
    // Switching on makes sure level1 … levelN exist. Nothing is ever deleted
    // — a level beyond the count, or every level but the current one when
    // switching off, is kept for when it is wanted again.
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
  }

  // Connection: only reconnected if something about it changed.
  const relay = relayInput.value.trim();
  const inRoom = mode === 'host' || mode === 'join';
  const room = (inRoom ? peerRoom(roomInput.value) : roomInput.value.trim()) || 'arcade';
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
  // Someone joining starts the editor with the host's project, once it comes.
  if (!editorStarted && mode !== 'join') {
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
