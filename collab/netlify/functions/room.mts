/**
 * The shared room: one small server-side cell holding the current project.
 *
 * Runs as a Netlify Function so the page and its sync live on the same origin.
 * That matters more than elegance here: the target users are on school-managed
 * devices where a second domain is a second thing that can be blocked, and
 * where WebSockets and WebRTC are commonly filtered. This is plain HTTPS
 * request/response, which is the traffic most likely to be allowed.
 */
import { getStore } from '@netlify/blobs';
import type { Config, Context } from '@netlify/functions';

interface RoomState {
  /** Monotonic counter; peers use it to tell new content from an echo. */
  version: number;
  /** The MakeCode project file map, as JSON. */
  project: unknown;
  /** Who wrote it, so a peer can ignore its own write coming back. */
  author: string;
  updatedAt: number;
}

const MAX_BODY_BYTES = 2_000_000;

export default async (request: Request, context: Context): Promise<Response> => {
  const code = normalizeRoom(context.params.code);
  if (!code) {
    return json({ error: 'bad_room' }, 400);
  }

  const store = getStore({ name: 'arcade-rooms', consistency: 'strong' });

  if (request.method === 'GET') {
    const state = await store.get(code, { type: 'json' });
    // 204 means the room exists but nobody has saved into it yet, which is
    // different from an error and lets the first participant seed it.
    return state ? json(state) : new Response(null, { status: 204, headers: cors() });
  }

  if (request.method === 'PUT') {
    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) {
      return json({ error: 'too_large' }, 413);
    }

    let incoming: Partial<RoomState>;
    try {
      incoming = JSON.parse(raw);
    } catch {
      return json({ error: 'bad_json' }, 400);
    }
    if (incoming.project === undefined || typeof incoming.author !== 'string') {
      return json({ error: 'bad_body' }, 400);
    }

    const current = (await store.get(code, { type: 'json' })) as RoomState | null;
    const next: RoomState = {
      version: (current?.version ?? 0) + 1,
      project: incoming.project,
      author: incoming.author,
      updatedAt: Date.now(),
    };
    await store.setJSON(code, next);
    return json({ version: next.version, updatedAt: next.updatedAt });
  }

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors() });
  }

  return json({ error: 'method_not_allowed' }, 405);
};

export const config: Config = {
  path: '/api/room/:code',
};

/** Room codes are user-visible and typed by hand, so keep them simple and safe
 * to use as a storage key. */
function normalizeRoom(code: string | undefined): string | undefined {
  if (!code) {
    return undefined;
  }
  const cleaned = code.toLowerCase().replace(/[^a-z0-9-]/g, '');
  return cleaned.length >= 3 && cleaned.length <= 40 ? cleaned : undefined;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...cors() },
  });
}

function cors(): Record<string, string> {
  return {
    // The page is served from this same origin; these headers only matter for
    // local development against a deployed function.
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,PUT,OPTIONS',
    'access-control-allow-headers': 'content-type',
    'cache-control': 'no-store',
  };
}
