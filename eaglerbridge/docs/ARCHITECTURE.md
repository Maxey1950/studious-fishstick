# Eaglercraft → offline-mode Java server bridge — architecture notes

Status: **plan confirmed, config not yet validated against live upstream configs**.
This document is the research record behind the scaffold in this directory. Treat
every "confirmed" item as backed by a source; every "assumed"/"needs verification"
item as something to check against the real upstream project before relying on it.

## 1. What we're actually bridging

Minecraft moved to calendar-based versioning in 2026: after the `1.21.x` line,
Mojang shipped `26.1` ("Tiny Takeover", Mar 2026), `26.2` ("Chaos Cubed", Jun 2026),
and `26.3` ("Wilderness Bound", Sep 2026, current latest). Some tooling (e.g.
EaglerXPaper's compatibility table) still labels this line internally as
`1.21.11+` — that's the same thing as `26.x`, just an older internal numbering
convention that predates the marketing rename. This resolves what looked like a
contradiction earlier in planning (client described as both "1.21.11" and "26.2").

**Client**: an `EaglercraftX Wasm-GC` build, marketed version `26.2` (`0.6-dev`).
This is a genuine from-scratch rewrite (WebAssembly-GC, not the old asm.js/applet
client), targeting native protocol close to real MC `26.2`. Confirmed sibling
build `EaglercraftX 26.1.2` reports **native protocol 775**.

The source for this specific `26.2` build isn't available (owner isn't sharing
it), so the exact protocol integer for `26.2` (776, or whatever Mojang
assigned — could also just be 775 if this build hasn't bumped past 26.1.2's
protocol yet) can't be read directly. **Decision: proceed with `775` as the
configured client protocol**, on the assumption that the 26.1→26.2 delta
either didn't change the protocol number or is close enough for ViaVersion to
paper over. This is a working assumption, not a confirmed fact — see the
failure mode noted in item 1 of §5.

**Target server**: real, offline-mode ("cracked"), version `26.1` or `26.2` —
i.e. at most a one-drop gap from the client, possibly none. This is a much
smaller translation job than a naive "ancient Eaglercraft protocol → current
release" scenario would be.

**Feature ceiling** (item 4 of the original ask): with a ≤1-drop gap, the
ceiling is minimal — at most the handful of blocks/entities/mechanics that
shipped in whichever single drop separates client and server. This is a
fundamentally different situation from bridging e.g. protocol 47 (1.8.8) to a
current server, where large swaths of newer content would be invisible/unusable
on the client no matter how good the packet translation is.

## 2. Why this isn't a from-scratch bridge

Two actively maintained upstream projects already cover the two jobs in the
original architecture sketch:

- **[EaglerXServer](https://github.com/lax1dude/eaglerxserver)** (by the
  original Eaglercraft author) — the WebSocket↔raw-TCP gateway. Runs as a
  Velocity/BungeeCord plugin, or as `EaglerXServer-Standalone.jar` with a
  single TOML config file, with no full proxy install needed. It terminates
  the browser's `wss://` connection and forwards a normal Minecraft TCP stream
  to a configured backend `host:port`.
- **[ViaProxy](https://github.com/ViaVersion/ViaProxy)** (ViaVersion team,
  actively maintained — v3.4.13 released 2026-09-19, bundling ViaVersion 5.12,
  with confirmed support for client/server versions 26.1 through 26.3) — the
  standalone protocol-translation hop. It listens on a local port, and
  connects onward to `target-address` (the real server), translating whatever
  protocol the inbound connection speaks to whatever the target expects.

A fork called **[EaglerXPaper](https://github.com/PlanetDogeCodes/EaglerXPaper)**
also exists and explicitly supports "26.x", but it works by injecting into a
Paper server's own Netty pipeline and sharing its game port — i.e. it only
works when you **run the destination server yourself**. Since our target is a
real third-party server we don't control (can't install plugins on it), this
option is out of scope here; regular `EaglerXServer` in gateway/standalone mode
is the right component.

There is also a maintained-adjacent fork,
**[ViaProxyEaglercraft](https://github.com/radmanplays/ViaProxyEaglercraft)**,
that adds a native WebSocket listener directly to ViaProxy, which would
collapse the two hops below into one process. It wasn't evaluated in depth
(unclear maintenance/currency vs. upstream ViaProxy) — worth a closer look
before ruling it out, but the two-hop composition below only depends on
projects with a confirmed, current release.

## 3. Chosen architecture

```
Eaglercraft client (browser, wss://)
        │
        ▼
EaglerXServer-Standalone          # gateway/ — we run this
  listens on wss://<gateway>:8080
  backend = 127.0.0.1:25568       # points at ViaProxy, NOT the real server
        │  raw MC TCP, client's native protocol
        ▼
ViaProxy                          # viaproxy/ — we run this
  bind-port: 25568
  target-address: <real server>:<port>
  client protocol: native Eaglercraft protocol (TBD — see open items)
  target protocol: auto-detect (server's actual version)
        │  raw MC TCP, translated to target's protocol
        ▼
Real offline-mode Java server (26.1 or 26.2)
```

Both hops are separate JVM processes (containers in the scaffold's
`docker-compose.yml`), configured via files, not custom code — the "bridge" is
composition + configuration, not a service we write.

## 4. WebSocket framing (item 1 of the original ask)

Not independently confirmed from this client's source (we only have the
hosted HTML/JS bundle, not a matching GitHub repo). Based on the broader
Eaglercraft ecosystem convention that EaglerXServer/EaglerXPaper implement
(and that this client is presumably compatible with, since nothing suggests
it invented a new gateway protocol): each Minecraft protocol packet is sent
as one binary WebSocket frame, plus an out-of-band channel used before the
game connection starts (server icon/MOTD query, and historically a "special"
handshake packet identifying the connection as Eaglercraft rather than vanilla
TCP). **Action item**: pull the actual client bundle's JS/wasm and grep for
the WebSocket send/receive path to confirm frame boundaries and any
handshake preamble before wiring the gateway config — don't trust this
paragraph blindly.

## 5a. Corrections from reading the real EaglerXServer config reference

The rest of this document was written before pulling EaglerXServer's actual
generated config reference
([`CONFIG.md`](https://github.com/lax1dude/eaglerxserver/blob/main/CONFIG.md),
derived from its v1.1.1 source) and ViaProxy's real README. Several
assumptions above turned out wrong; corrections:

- **There is no `EaglerXServer-Standalone.jar`.** Confirmed against the
  v1.1.1 release assets: the only artifact is a single universal
  `EaglerXServer.jar` plugin for Spigot/BungeeCord/Velocity. It has to run
  *inside* a real Velocity (or BungeeCord/Spigot) process — the scaffold now
  runs actual Velocity with EaglerXServer as a plugin, not a fictitious
  standalone gateway binary.
- **EaglerXServer has no backend/target-address config of its own, and no
  separate listen port.** It injects into the *host proxy's own existing
  listener* (`inject_address`, defaulting to Velocity's own bind address)
  and multiplexes Eaglercraft WebSocket + plain Minecraft TCP on that single
  port by sniffing the first bytes of each connection. Routing to a backend
  is entirely Velocity's own job (`[servers]` / `try` in Velocity's real
  `velocity.toml`) — EaglerXServer doesn't participate in that decision at
  all. The earlier scaffold's `[listener.backend]` block was fabricated and
  has been removed.
- **Two separate "protocol version" axes exist in EaglerXServer's config —
  don't conflate them**: `protocol_v1`..`v5`/`protocol_legacy_allowed` gate
  the *Eaglercraft WebSocket wrapper's own* handshake/framing version
  (a small versioning scheme EaglerXServer itself defines); separately,
  `min_minecraft_protocol`/`max_minecraft_protocol` gate the actual embedded
  Minecraft protocol integer. Our "775 vs 776" question is about the latter.
- **New, significant risk: `max_minecraft_protocol` defaults to 340
  (MC 1.12.2)** in EaglerXServer 1.1.1. This must be raised to accept a
  775-class client (done in the scaffold's `settings.toml`), but raising a
  config number is only a permission gate — it says nothing about whether
  the plugin's actual packet-handling code understands modern login-flow
  changes introduced well after 1.12.2 (the 1.20.2+ "Configuration" state,
  1.20.5+ cookies/transfer packets, etc.). This has **not been verified** to
  actually work; treat successfully connecting past the handshake as the
  first real test of this whole architecture, not a formality.
- **EaglerXPaper remains Paper-plugin-only** (confirmed: "Deployment mode:
  Plugin-only... shares the main server port"). There is still no confirmed
  gateway component with native 26.x support for a "front of network, don't
  own the destination server" topology other than plain EaglerXServer with
  its protocol cap manually raised (previous point) — EaglerXPaper only
  helps if you run the destination Paper server yourself.
- **ViaProxy's real README confirms wider support than assumed earlier**:
  both server and client version lists explicitly say "Release (1.0.0/1.7.2
  - 26.3)" — so upstream ViaProxy itself, not just the radmanplays fork, is
  confirmed current for this entire version range in both directions.
- **ViaProxy ships an official Docker image**
  (`ghcr.io/viaversion/viaproxy:latest`, confirmed from its README) with a
  documented one-line run command — the scaffold now uses that instead of a
  hand-guessed jar invocation. Its config (`viaproxy.yml` plus a `ViaLoader/`
  folder with `viaversion.yml`/`viabackwards.yml`/etc.) is **generated on
  first run**, not something to author from scratch — `viaproxy.yml.reference`
  in this scaffold is a list of which keys to change afterward, not a
  drop-in file.

## 5. Open items before this goes further than config

1. Protocol integer is set to `775` (EaglercraftX 26.1.2's confirmed number)
   as a deliberate assumption, since the client's source isn't available.
   **Failure mode to watch for**: if the real `26.2` client uses a different
   protocol integer, the handshake will fail cleanly (ViaProxy/the target
   server will reject or misparse the login packet) rather than silently
   misbehaving — so this is safe to try, but treat any connection failure
   at the handshake stage as "check this number first," not a config bug
   elsewhere. Revisit if/when the source becomes available.
2. Confirm WebSocket framing against the actual client bundle (section 4).
3. `gateway/plugins/EaglerXServer/*.toml` are skeletons of the *real*
   documented keys (§5a) but not the full generated file — let EaglerXServer
   generate the complete file on first run and merge these values in, rather
   than replacing it outright. `viaproxy/viaproxy.yml.reference` is the same
   situation, more so, since ViaProxy's schema wasn't independently verified
   beyond `target-address`/`bind-port` — generate first, then edit.
4. **New, unverified, and the biggest real risk (§5a)**: does EaglerXServer
   1.1.1 actually handle a 775-class client's login sequence correctly once
   `max_minecraft_protocol` is raised, or does it only understand protocol
   *numbers* up to that value while still assuming pre-1.20.2 packet flow
   internally? This can only be answered by actually trying the connection.
5. Offline-auth handshake: Velocity's own `online-mode = false` is set in
   `gateway/config/velocity.toml` (confirmed real Velocity key), so Velocity
   won't try Mojang auth on the incoming Eaglercraft connection. Still
   unconfirmed: ViaProxy's own join-mode setting for passing the same
   offline UUID through to the real target server rather than attempting
   Microsoft account auth — generate ViaProxy's config and check its actual
   auth-related keys (item 3) before relying on this.
6. Confirm whether ViaProxy's 26.x support needs a newer JRE than the
   `eclipse-temurin:21-jre-jammy` the gateway container assumes (EaglerXPaper's
   docs note Java 25+ for Paper 26.x — ViaProxy's own JRE requirement for the
   same protocol range wasn't checked here; its official Docker image sidesteps
   this for ViaProxy itself, but the gateway/Velocity side still needs it
   verified).
