# Eaglercraft → offline-mode Java server bridge

Lets an `EaglercraftX Wasm-GC` (26.2) browser client join a real, offline-mode
("cracked") Java Edition server on a nearby version (26.1/26.2), via two
existing, actively maintained upstream projects rather than custom relay code.
Full rationale and open items in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
— **read that before deploying this**, several fields below are unconfirmed
placeholders.

## Components

| Piece | Project | Role |
|---|---|---|
| `gateway/` | [EaglerXServer-Standalone](https://github.com/lax1dude/eaglerxserver) | Terminates the browser's `wss://` connection, re-emits raw Minecraft TCP |
| `viaproxy/` | [ViaProxy](https://github.com/ViaVersion/ViaProxy) | Translates client protocol → target server's protocol |

Neither directory contains a jar — download the matching release into each
before running:

- `gateway/EaglerXServer-Standalone.jar` from the EaglerXServer releases page
- `viaproxy/ViaProxy.jar` from the ViaProxy releases page

## Setup

1. `cp .env.example .env` and fill in `TARGET_SERVER_HOST`/`TARGET_SERVER_PORT`.
2. Confirm the Eaglercraft client's actual native protocol version (see
   `docs/ARCHITECTURE.md` §4-5 — do not guess) and set `CLIENT_PROTOCOL_VERSION`.
3. Reconcile `gateway/config/velocity.toml` and `viaproxy/config/viaproxy.yml`
   against the real sample configs shipped in each project's release — the
   versions here are structural placeholders, not verified schemas.
4. `docker compose up -d`
5. Point the Eaglercraft client at `wss://<this host>:${GATEWAY_PORT}`.

## Known gaps (see docs/ARCHITECTURE.md for detail)

- Client protocol set to `775` (EaglercraftX 26.1.2's confirmed number) as a
  working assumption — the actual `26.2` client's source isn't available.
  If the connection fails at handshake, check this number first.
- WebSocket framing assumed from ecosystem convention, not verified against
  this specific client's source.
- Offline-auth passthrough (UUID consistency between gateway and ViaProxy)
  not yet validated end-to-end.
