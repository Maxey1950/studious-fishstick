// VEX IQ (2nd gen) side of the browser control panel.
//
// Three concerns, deliberately separated:
//
//   1. A reader task owns the blocking getchar() loop and does nothing else.
//   2. Commands mutate a small shared Setpoint struct under a mutex; motors
//      are written from one place only.
//   3. The control task applies the setpoint at a fixed rate and enforces a
//      watchdog: no command for kWatchdogMs and the drive stops.
//
// The watchdog is the important part. On a Bluetooth link the browser tab can
// be closed, the laptop can sleep, or the connection can drop mid-command --
// none of which produce a STOP. Without the watchdog the robot keeps driving.

#include "vex.h"
#include "vex_protocol.h"

using namespace vex;

brain      Brain;
motor      LeftMotor(PORT1, false);
motor      RightMotor(PORT6, true);
controller Controller;

namespace {

const int      kMaxPct      = 100;
const uint32_t kWatchdogMs  = 500;   // no command for this long -> stop
const uint32_t kControlMs   = 20;    // motor update period
const uint32_t kTelemetryMs = 200;   // telemetry period

struct Setpoint {
  int  left;
  int  right;
  bool enabled;
  Setpoint() : left(0), right(0), enabled(false) {}
};

Setpoint  g_sp;
mutex     g_spLock;
uint32_t  g_lastCommandMs = 0;

proto::LineAssembler g_assembler;
proto::CommandRouter g_router;

void setDrive(int left, int right) {
  g_spLock.lock();
  g_sp.left    = left;
  g_sp.right   = right;
  g_sp.enabled = true;
  g_lastCommandMs = Brain.Timer.system();  // under the lock: the control task reads it
  g_spLock.unlock();
}

// --- reply helpers ---------------------------------------------------------
// printf goes back over the same virtual COM port the browser is reading.

void reply(const char* verb, const char* const* argv, size_t argc) {
  char out[96];
  size_t n = proto::formatCommand(out, sizeof out, verb, argv, argc);
  if (n > 0) printf("%s", out);
}

void replyInt(const char* verb, int value) {
  char v[16];
  snprintf(v, sizeof v, "%d", value);
  const char* argv[] = {v};
  reply(verb, argv, 1);
}

// --- handlers --------------------------------------------------------------

// DRIVE:<pct>            both sides forward at pct
void onDrive(const proto::Command& c, void*) {
  int pct = 0;
  if (!c.getIntClamped(0, -kMaxPct, kMaxPct, &pct)) {
    replyInt("ERR", 1);  // malformed argument: refuse rather than guess
    return;
  }
  setDrive(pct, pct);
}

// ARCADE:<left>,<right>  independent sides
void onArcade(const proto::Command& c, void*) {
  int l = 0, r = 0;
  if (!c.getIntClamped(0, -kMaxPct, kMaxPct, &l) ||
      !c.getIntClamped(1, -kMaxPct, kMaxPct, &r)) {
    replyInt("ERR", 1);
    return;
  }
  setDrive(l, r);
}

// FORWARD / BACK / LEFT / RIGHT [:pct]   pct defaults to 50
void onNudge(const proto::Command& c, void*) {
  int pct = c.intOr(0, 50);
  if (pct < 0) pct = 0;
  if (pct > kMaxPct) pct = kMaxPct;

  if (c.isVerb("FORWARD"))    setDrive(pct, pct);
  else if (c.isVerb("BACK"))  setDrive(-pct, -pct);
  else if (c.isVerb("LEFT"))  setDrive(-pct, pct);
  else if (c.isVerb("RIGHT")) setDrive(pct, -pct);
}

// STOP
void onStop(const proto::Command&, void*) { setDrive(0, 0); }

// PING  -> PONG, so the browser can measure round-trip latency.
void onPing(const proto::Command& c, void*) {
  if (c.argc() > 0) {
    const char* argv[] = {c.arg(0)};
    reply("PONG", argv, 1);
  } else {
    reply("PONG", 0, 0);
  }
}

void onUnknown(const proto::Command&, void*) { replyInt("ERR", 2); }

// --- tasks -----------------------------------------------------------------

// getchar() blocks until a byte arrives, so it gets its own task. Keeping it
// out of the main loop is what lets telemetry keep flowing while the browser
// is silent.
int readerTask() {
  while (true) {
    int ch = getchar();
    if (ch < 0) {           // no data / stream closed: yield and retry
      this_thread::sleep_for(5);
      continue;
    }
    char c = static_cast<char>(ch);
    g_router.feed(&c, 1, &g_assembler, 0);
  }
  return 0;
}

int telemetryTask() {
  unsigned long lastOverflows = 0;
  while (true) {
    replyInt("BATTERY", Brain.battery.capacity(percentUnits::pct));

    g_spLock.lock();
    int l = g_sp.left, r = g_sp.right;
    g_spLock.unlock();
    char ls[16], rs[16];
    snprintf(ls, sizeof ls, "%d", l);
    snprintf(rs, sizeof rs, "%d", r);
    const char* argv[] = {ls, rs};
    reply("SPEED", argv, 2);

    // Surface link health instead of hiding it: a climbing count means the
    // browser and the brain disagree about framing.
    unsigned long ov = g_assembler.overflows();
    if (ov != lastOverflows) {
      replyInt("DROPPED", static_cast<int>(ov));
      lastOverflows = ov;
    }

    this_thread::sleep_for(kTelemetryMs);
  }
  return 0;
}

int controlTask() {
  while (true) {
    uint32_t now = Brain.Timer.system();

    g_spLock.lock();
    bool stale = g_sp.enabled && (now - g_lastCommandMs > kWatchdogMs);
    if (stale) {
      g_sp.left = g_sp.right = 0;
      g_sp.enabled = false;
    }
    int l = g_sp.left, r = g_sp.right;
    g_spLock.unlock();

    if (stale) reply("WATCHDOG", 0, 0);

    if (l == 0) LeftMotor.stop(brakeType::brake);
    else        LeftMotor.spin(directionType::fwd, l, velocityUnits::pct);

    if (r == 0) RightMotor.stop(brakeType::brake);
    else        RightMotor.spin(directionType::fwd, r, velocityUnits::pct);

    this_thread::sleep_for(kControlMs);
  }
  return 0;
}

}  // namespace

int main() {
  g_router.on("DRIVE",   onDrive);
  g_router.on("ARCADE",  onArcade);
  g_router.on("FORWARD", onNudge);
  g_router.on("BACK",    onNudge);
  g_router.on("LEFT",    onNudge);
  g_router.on("RIGHT",   onNudge);
  g_router.on("STOP",    onStop);
  g_router.on("PING",    onPing);
  g_router.onUnknown(onUnknown);

  LeftMotor.setStopping(brakeType::brake);
  RightMotor.setStopping(brakeType::brake);

  Brain.Screen.printAt(10, 30, "control panel link ready");
  reply("READY", 0, 0);

  task reader(readerTask);
  task telemetry(telemetryTask);
  task control(controlTask);

  while (true) this_thread::sleep_for(100);
}
