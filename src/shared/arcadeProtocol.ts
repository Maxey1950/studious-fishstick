/**
 * The MakeCode Arcade controller-embed protocol.
 *
 * Typed from pxt-core's own `localtypings/pxteditor.d.ts` and checked against
 * the shipped editor bundle. The editor is loaded with `?controller=1&ws=iframe`,
 * which makes it treat this page as its workspace host: it asks us for projects,
 * and pushes the project back every time it changes.
 *
 * Note which way the `type` field points, because it is easy to get backwards:
 * messages the editor sends *to the host* are `pxthost`, and commands the host
 * sends *to the editor* are `pxteditor`. A response to a host-channel request
 * keeps `pxthost` and echoes the request's id.
 *
 * Message handling is written as a pure function so the handshake can be tested
 * without a browser or a network.
 */

import { withDeclaredStubs } from './projectFiles';

/**
 * `ws=iframe` is the important part: it tells the editor its workspace lives in
 * the host page, so it asks us for the project. With `ws=browser` it uses its
 * own IndexedDB instead, ignores the file, opens blank — and then saves that
 * blank project back over the user's work.
 */
export const ARCADE_EDITOR_URL =
  'https://arcade.makecode.com/?controller=1&ws=iframe&nocookiebanner=1';

/**
 * True when XML carries no blocks at all.
 *
 * Used as a safety check: an editor that failed to load its project reports an
 * empty workspace, and writing that back would destroy the file.
 */
export function hasNoBlocks(xml: string): boolean {
  return !/<block\b/i.test(xml);
}

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
  // `pxthost` is the editor talking to us. `pxteditor` is us talking to it, so
  // seeing one here means our own message echoed back.
  if (!message || typeof message !== 'object' || message.type !== 'pxthost') {
    return { kind: 'ignore' };
  }

  switch (message.action) {
    case 'workspacesync':
      // The editor is asking for the list of projects it should work with.
      // A response stays on the host channel and echoes the request id.
      return {
        kind: 'reply',
        message: {
          type: 'pxthost',
          id: message.id,
          success: true,
          // Every file the project declares has to be there, or it does not
          // build and there is nothing to run.
          projects: [withDeclaredStubs(project)],
        },
      };

    case 'newproject':
      // Sent when the editor would otherwise create an empty project. Answering
      // keeps it from replacing the file with a blank one.
      return {
        kind: 'reply',
        message: {
          type: 'pxthost',
          id: message.id,
          success: true,
          // Every file the project declares has to be there, or it does not
          // build and there is nothing to run.
          projects: [withDeclaredStubs(project)],
        },
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

/** Builds the message that loads a project into the editor. Host-to-editor
 * commands travel on the `pxteditor` channel. */
export function importProjectMessage(project: ArcadeProject): Record<string, unknown> {
  return { type: 'pxteditor', action: 'importproject', project: withDeclaredStubs(project) };
}

/**
 * A bare command for the editor, for the actions that carry no payload.
 *
 * `restartsimulator` is the one that matters here: blocks applied straight into
 * the workspace go in with Blockly's events switched off, so the editor never
 * learns its program changed and the simulator keeps running the old one.
 */
export function editorCommand(action: string): Record<string, unknown> {
  return { type: 'pxteditor', action };
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

/**
 * Puts new block XML into an existing project, keeping every other file.
 *
 * Rebuilding the project from the blocks alone would discard `pxt.json`, which
 * is where the extension list lives, along with `assets.json` and any generated
 * `main.ts`. Adding an extension and then receiving someone else's edit would
 * silently remove the extension.
 */
export function withBlocks(project: ArcadeProject, blocks: string): ArcadeProject {
  return {
    header: project.header,
    text: { ...project.text, 'main.blocks': blocks },
  };
}
