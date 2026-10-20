/**
 * The relay Arcade Collab needs to sync between computers.
 *
 * It does one thing: every message a browser sends is passed to every other
 * browser in the same room. It stores nothing and understands nothing — the
 * project lives in the browsers, and the relay only carries changes between
 * them.
 *
 * Run it anywhere that can host a small Node server and that your network does
 * not block:
 *
 *   npm install ws
 *   PORT=8080 node relay.mjs
 *
 * Then press Connect in Arcade Collab and enter its address, e.g.
 * wss://your-relay.example. Everyone who enters the same room name edits
 * together.
 */
import { WebSocketServer } from 'ws';

const port = Number(process.env.PORT) || 8080;
const server = new WebSocketServer({ port });

/** Room name → the browsers in it. */
const rooms = new Map();

server.on('connection', (socket, request) => {
  const room = new URL(request.url ?? '/', 'http://relay').searchParams.get('room') || 'arcade';
  if (!rooms.has(room)) {
    rooms.set(room, new Set());
  }
  const members = rooms.get(room);
  members.add(socket);

  socket.on('message', (data, isBinary) => {
    for (const other of members) {
      if (other !== socket && other.readyState === other.OPEN) {
        other.send(data, { binary: isBinary });
      }
    }
  });

  socket.on('close', () => {
    members.delete(socket);
    if (!members.size) {
      rooms.delete(room);
    }
  });
});

console.log(`Arcade Collab relay listening on port ${port}`);
