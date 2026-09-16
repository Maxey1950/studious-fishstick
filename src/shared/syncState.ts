/**
 * Decides when to send local edits and when to apply remote ones.
 *
 * This is the whole subtlety of the collaboration, kept apart from the network
 * and the editor so it can be tested directly.
 *
 * The constraint it exists to manage: MakeCode's embed API has no patch
 * operation. Applying a peer's change means `importproject`, which rebuilds the
 * entire editor and throws away scroll position, selection and undo history. So
 * remote changes are held until the local user pauses — you are never
 * interrupted mid-edit, you are caught up when you stop.
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
   * This is not politeness: applying one rebuilds the whole editor, so landing
   * it mid-gesture would take the block out of the user's hand. Someone who has
   * not edited at all is never delayed — the wait starts from their last change,
   * so a passive viewer sees updates immediately.
   */
  applyAfterIdleMs: number;
}

export const DEFAULT_SYNC_OPTIONS: SyncOptions = {
  sendDebounceMs: 250,
  applyAfterIdleMs: 900,
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
  /** A peer's content we have not applied yet. */
  pendingRemote?: string;
  /** Content we applied from a peer; the editor will echo it straight back. */
  appliedRemote?: string;
  lastLocalChangeMs: number;
  lastLocalUnsentMs?: number;
}

export class SyncState {
  private state: State = { lastLocalChangeMs: Number.NEGATIVE_INFINITY };

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
  next(nowMs: number): SyncEffect | undefined {
    const { sendDebounceMs, applyAfterIdleMs } = this.options;

    if (this.state.lastLocalUnsentMs !== undefined && this.state.local !== undefined) {
      const dueAt = this.state.lastLocalUnsentMs + sendDebounceMs;
      if (nowMs >= dueAt) {
        const blocks = this.state.local;
        this.state.sent = blocks;
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
        return { kind: 'apply', blocks };
      }
      return { kind: 'wait', untilMs: dueAt };
    }

    return undefined;
  }

  /** True while a peer's change is waiting for the user to pause. */
  hasPendingRemote(): boolean {
    return this.state.pendingRemote !== undefined;
  }
}
