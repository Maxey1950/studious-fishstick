# Eaglercraft → offline-mode Java server bridge

Lets an `EaglercraftX Wasm-GC` (26.2) browser client join a real, offline-mode
("cracked") Java Edition server on a nearby version (26.1/26.2), via two
existing, actively maintained upstream projects rather than custom relay code.
Full rationale, corrections from reading primary sources, and open risks are
in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — **read that before
deploying this**, especially §5a and §5 item 4, which flag a real,
unverified risk in this plan (whether EaglerXServer's login-flow code
actually supports a modern client once its protocol cap is raised, versus
just accepting the number and then breaking).

## Components

| Piece | Project | Role |
|---|---|---|
| `gateway/` | [Velocity](https://papermc.io/software/velocity) + [EaglerXServer](https://github.com/lax1dude/eaglerxserver) plugin | Terminates the browser's `wss://` connection, re-emits raw Minecraft TCP |
| `viaproxy/` | [ViaProxy](https://github.com/ViaVersion/ViaProxy) (official Docker image) | Translates client protocol → target server's protocol |

There is **no standalone EaglerXServer artifact** (confirmed against its
release assets) — it's a plugin that runs inside a real Velocity process.
Before starting:

- download `velocity.jar` (PaperMC Velocity) into `gateway/`
- download `EaglerXServer.jar` from the
  [EaglerXServer releases page](https://github.com/lax1dude/eaglerxserver/releases)
  into `gateway/plugins/`

`viaproxy/` needs nothing downloaded — it runs from the official
`ghcr.io/viaversion/viaproxy:latest` image.

## Setup

1. `cp .env.example .env` and fill in `TARGET_SERVER_HOST`/`TARGET_SERVER_PORT`.
2. `docker compose up -d viaproxy`, then generate its real config once per
   ViaProxy's own "Usage for Server owners (Config)" instructions (it
   generates `viaproxy.yml` and a `ViaLoader/` folder into the mounted
   `viaproxy/run/` and exits) — `viaproxy/viaproxy.yml.reference` lists which
   keys to then edit (`bind-port`, `target-address`, client protocol), it is
   **not** a drop-in file.
3. Confirm the Eaglercraft client's actual native protocol version if you
   ever get access to its source (see `docs/ARCHITECTURE.md` §5 item 1) —
   currently pinned to `775` (EaglercraftX 26.1.2's confirmed protocol) as a
   deliberate stand-in.
4. Let EaglerXServer generate its own full config on first launch of the
   `gateway` service, then merge in the values from
   `gateway/plugins/EaglerXServer/settings.toml` and `listeners.toml` (raised
   `max_minecraft_protocol`, `inject_address` matching Velocity's `bind`) —
   don't replace the generated file outright.
5. `docker compose up -d`
6. Point the Eaglercraft client at `wss://<this host>:${GATEWAY_PORT}`.

## Known gaps and risks (see docs/ARCHITECTURE.md for detail)

- **Biggest unverified risk**: EaglerXServer 1.1.1 defaults its protocol cap
  to 340 (MC 1.12.2); raising it to 775 is a permission gate, not proof the
  plugin's login-flow code understands anything past that era. This has not
  been tested end-to-end.
- Client protocol set to `775` as a working assumption — the actual `26.2`
  client's source isn't available. If the connection fails at handshake,
  check this number first.
- WebSocket framing assumed from ecosystem convention, not verified against
  this specific client's source.
- Offline-auth passthrough (UUID consistency between gateway and ViaProxy)
  not yet validated end-to-end.
