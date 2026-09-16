/**
 * The MakeCode Arcade controller-embed protocol.
 *
 * Typed from pxt-core's own `localtypings/pxteditor.d.ts`. The editor is loaded
 * with `?controller=1&ws=browser`, which makes it treat this page as its
 * workspace host: it asks us for projects, and pushes the project back every
 * time it changes.
 *
 * Message handling is written as a pure function so the handshake can be tested
 * without a browser or a network.
 */

export const ARCADE_EDITOR_URL =
  'https://arcade.makecode.com/?controller=1&ws=browser&nocookiebanner=1';

/** The file map of a MakeCode project. `main.blocks` is the block XML. */
export type ProjectText = Record<string, string>;

export interface ArcadeProject {
  header: Record<string, unknown>;
  text: ProjectText;
}

export interface EditorMessage {
  type?: string;
  action?: string;
  id?: string;
  project?: ArcadeProject;
  [key: string]: unknown;
}

/** What the host should do in response to a message from the editor. */
export type BridgeOutcome =
  /** Post this back to the editor. */
  | { kind: 'reply'; message: Record<string, unknown> }
  /** The editor pushed a changed project. */
  | { kind: 'projectChanged'; project: ArcadeProject }
  /** Progress worth showing the user. */
  | { kind: 'status'; status: EditorStatus }
  | { kind: 'ignore' };

export type EditorStatus = 'loading' | 'syncing' | 'ready';

/**
 * Interprets one message from the embedded editor.
 *
 * `project` is what the host currently holds, used to answer the editor's
 * initial request for the workspace contents.
 */
export function handleEditorMessage(
  message: EditorMessage,
  project: ArcadeProject
): BridgeOutcome {
  if (!message || typeof message !== 'object' || message.type !== 'pxteditor') {
    return { kind: 'ignore' };
  }

  switch (message.action) {
    case 'workspacesync':
      // The editor is asking for the list of projects it should work with.
      return {
        kind: 'reply',
        message: { type: 'pxthost', id: message.id, success: true, projects: [project] },
      };

    case 'workspacereset':
      return { kind: 'reply', message: { type: 'pxthost', id: message.id, success: true } };

    case 'workspacesave': {
      if (!message.project?.text) {
        return { kind: 'ignore' };
      }
      return { kind: 'projectChanged', project: message.project };
    }

    case 'workspaceloaded':
    case 'editorcontentloaded':
      return { kind: 'status', status: 'ready' };

    default:
      return { kind: 'ignore' };
  }
}

/** Builds the message that loads a project into the editor. */
export function importProjectMessage(project: ArcadeProject): Record<string, unknown> {
  return { type: 'pxthost', action: 'importproject', project };
}

/** A minimal Arcade project around a `.blocks` document. */
export function createProject(name: string, blocks: string): ArcadeProject {
  return {
    header: {
      name,
      id: `collab-${name}`,
      editor: 'blocksprj',
      pubId: '',
      pubCurrent: false,
      target: 'arcade',
      recentUse: Date.now(),
      modificationTime: Date.now(),
      path: name,
      cloudUserId: null,
      cloudCurrent: false,
      cloudVersion: null,
      cloudLastSyncTime: 0,
      isDeleted: false,
    },
    text: {
      'main.blocks': blocks,
      // MakeCode regenerates main.ts from the blocks; a placeholder is enough.
      'main.ts': ' ',
      'pxt.json': JSON.stringify(
        {
          name,
          description: '',
          dependencies: { device: '*' },
          files: ['main.blocks', 'main.ts'],
        },
        null,
        2
      ),
    },
  };
}

/** The block XML a project carries, which is what peers exchange. */
export function blocksOf(project: ArcadeProject): string {
  return project.text['main.blocks'] ?? '';
}
