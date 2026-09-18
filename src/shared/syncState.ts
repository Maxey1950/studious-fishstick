/**
 * Decides when to send local edits and when to apply remote ones.
 *
 * This is the whole subtlety of the collaboration, kept apart from the network
 * and the editor so it can be tested directly.
 *
 * The constraint it exists to manage: MakeCode's embed API has no patch
 * operation. When the editor can only be reached through `importproject` — a
 * cross-origin embed — applying a peer's change rebuilds the entire editor and
 * throws away scroll position, selection and undo history, so remote changes
 * wait for the local user to pause. Reached same-origin they are applied block
 * by block, and the wait is a short one.
 */

export interface SyncOptions {
  /**
   * Quiet period after the last local change before it is written out. Lower is
   * more responsive for everyone else, at the cost of more document revisions.
   */
  sendDebounceMs: number;
  /**
   * How long the local user must be idle before a remote change is applied.
   *
   * Someone who has not edited at all is never delayed — the wait starts from
   * their last change, so a passive viewer sees updates immediately. The webview
   * additionally refuses to apply anything while a block is actually in the
   * user's hand, so this only has to cover the gap between gestures.
   */
  applyAfterIdleMs: number;
}

export const DEFAULT_SYNC_OPTIONS: SyncOptions = {
  sendDebounceMs: 100,
  applyAfterIdleMs: 150,
};

export type SyncEffect =
  | { kind: 'broadcast'; blocks: string }
  | { kind: 'apply'; blocks: string }
  /** Ask again at this time; nothing to do yet. */
  | { kind: 'wait'; untilMs: number };

interface State {
  /** What the editor most recently reported. */
  local?: string;
  /** What we last sent, so the same content is not sent twice. */
  sent?: string;
  /**
   * Everything sent recently, so our own echoes are recognized as ours.
   *
   * The last one is not enough. A drag sends several positions in quick
   * succession, and the echo of an earlier one arrives after the editor has
   * moved on — matching nothing current, it reads as a collaborator's change
   * and gets applied, which puts the block back where it was a moment ago.
   */
  sentHistory: string[];
  /** A peer's content we have not applied yet. */
  pendingRemote?: string;
  /** Content we applied from a peer; the editor will echo it straight back. */
  appliedRemote?: string;
  lastLocalChangeMs: number;
  lastLocalUnsentMs?: number;
}

export class SyncState {
  private state: State = { lastLocalChangeMs: Number.NEGATIVE_INFINITY, sentHistory: [] };

  /** How many recent sends to recognize. A drag is a handful; this is slack. */
  private static readonly HISTORY = 24;

  constructor(private readonly options: SyncOptions = DEFAULT_SYNC_OPTIONS) {}

  /** The editor reported a change (a `workspacesave` push). */
  onLocalChange(blocks: string, nowMs: number): void {
    // The editor echoes back whatever we imported. That echo is not a local
    // edit and must not be broadcast, or two peers would volley forever.
    if (blocks === this.state.appliedRemote) {
      this.state.local = blocks;
      return;
    }

    this.state.local = blocks;
    this.state.lastLocalChangeMs = nowMs;
    this.state.lastLocalUnsentMs = blocks === this.state.sent ? undefined : nowMs;

    // The user has moved on; a peer's older content is no longer worth applying
    // over the top of their work.
    this.state.pendingRemote = undefined;
  }

  /** A peer sent their content. */
  onRemoteChange(blocks: string, _nowMs: number): void {
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
  next(nowMs: number): SyncEffect | undefined {
    const { sendDebounceMs, applyAfterIdleMs } = this.options;

    if (this.state.lastLocalUnsentMs !== undefined && this.state.local !== undefined) {
      const dueAt = this.state.lastLocalUnsentMs + sendDebounceMs;
      if (nowMs >= dueAt) {
        const blocks = this.state.local;
        this.state.sent = blocks;
        this.remember(blocks);
        this.state.lastLocalUnsentMs = undefined;
        return { kind: 'broadcast', blocks };
      }
      return { kind: 'wait', untilMs: dueAt };
    }

    if (this.state.pendingRemote !== undefined) {
      const dueAt = this.state.lastLocalChangeMs + applyAfterIdleMs;
      if (nowMs >= dueAt) {
        const blocks = this.state.pendingRemote;
        this.state.pendingRemote = undefined;
        this.state.appliedRemote = blocks;
        // Treat applied content as already agreed, so the editor's echo of it
        // is not mistaken for a local edit worth sending back.
        this.state.sent = blocks;
        this.remember(blocks);
        return { kind: 'apply', blocks };
      }
      return { kind: 'wait', untilMs: dueAt };
    }

    return undefined;
  }

  /** Records content as ours, so its echo is never applied back over the user. */
  private remember(blocks: string): void {
    this.state.sentHistory.push(blocks);
    if (this.state.sentHistory.length > SyncState.HISTORY) {
      this.state.sentHistory.shift();
    }
  }

  /** True while a peer's change is waiting for the user to pause. */
  hasPendingRemote(): boolean {
    return this.state.pendingRemote !== undefined;
  }
}
