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
build `EaglercraftX 26.1.2` reports **native protocol 775**. The exact integer
for a `26.2` build (776, or whatever Mojang assigned) is *not yet confirmed* —
we only have the hosted page, not its source, so this must be read out of the
client's own JS/wasm bundle or a matching source repo before it's trusted.

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

## 5. Open items before this goes further than config

1. Confirm the exact native protocol integer the `26.2` client speaks (don't
   assume it's 775 — that's the confirmed number for a *different* build,
   `26.1.2`).
2. Confirm WebSocket framing against the actual client bundle (section 4).
3. Validate the EaglerXServer-Standalone TOML schema and the ViaProxy YAML
   schema against the sample configs shipped in their releases — the files in
   `gateway/config/` and `viaproxy/config/` in this scaffold are structural
   placeholders, not verified-correct configs.
4. Decide on the offline-auth handshake details: EaglerXServer needs to be
   told not to attempt online-mode auth, and ViaProxy's join mode needs to
   pass through the same offline UUID rather than trying Microsoft auth,
   so the UUID the real server sees matches what the client presents.
5. Confirm whether ViaProxy's 26.x support needs a newer JRE than the
   containers below assume (EaglerXPaper's docs note Java 25+ for Paper
   26.x — ViaProxy's own JRE requirement for the same protocol range should
   be checked against its release notes).
