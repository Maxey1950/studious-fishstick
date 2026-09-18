// Host-side tests for the framing/parsing layer. No VEX headers involved, so
// the protocol can be exercised on a laptop before it ever reaches the brain.
//
//   make -C robot/test run

#include "vex_protocol.h"

#include <stdio.h>
#include <string.h>
#include <vector>
#include <string>

using namespace proto;

static int g_failures = 0;
static int g_checks = 0;

#define CHECK(cond)                                                        \
  do {                                                                     \
    ++g_checks;                                                            \
    if (!(cond)) {                                                         \
      ++g_failures;                                                        \
      printf("FAIL %s:%d  %s\n", __FILE__, __LINE__, #cond);               \
    }                                                                      \
  } while (0)

#define CHECK_STR(a, b)                                                    \
  do {                                                                     \
    ++g_checks;                                                            \
    if (strcmp((a), (b)) != 0) {                                           \
      ++g_failures;                                                        \
      printf("FAIL %s:%d  \"%s\" != \"%s\"\n", __FILE__, __LINE__, (a), (b)); \
    }                                                                      \
  } while (0)

static void collect(const char* line, void* ctx) {
  static_cast<std::vector<std::string>*>(ctx)->push_back(line);
}

// Feeds `chunks` through one assembler and returns every line it produced.
static std::vector<std::string> run(const char* const* chunks, size_t n) {
  LineAssembler a;
  std::vector<std::string> out;
  for (size_t i = 0; i < n; ++i) {
    a.pushBlock(chunks[i], strlen(chunks[i]), collect, &out);
  }
  return out;
}

static void testFragmentation() {
  const char* chunks[] = {"DRI", "VE:5", "0\nST", "OP\n"};
  std::vector<std::string> lines = run(chunks, 4);
  CHECK(lines.size() == 2);
  CHECK_STR(lines[0].c_str(), "DRIVE:50");
  CHECK_STR(lines[1].c_str(), "STOP");
}

static void testMultipleLinesInOneChunk() {
  const char* chunks[] = {"A\nB\nC\n"};
  std::vector<std::string> lines = run(chunks, 1);
  CHECK(lines.size() == 3);
  CHECK_STR(lines[2].c_str(), "C");
}

static void testPartialTailIsHeld() {
  const char* chunks[] = {"STOP\nDRIV"};
  std::vector<std::string> lines = run(chunks, 1);
  CHECK(lines.size() == 1);  // the dangling "DRIV" is kept, not emitted
}

static void testCrLfAndBlankLines() {
  const char* chunks[] = {"STOP\r\n", "\r\n", "\n", "DRIVE:10\r\n"};
  std::vector<std::string> lines = run(chunks, 4);
  CHECK(lines.size() == 2);
  CHECK_STR(lines[0].c_str(), "STOP");
  CHECK_STR(lines[1].c_str(), "DRIVE:10");
}

static void testOverlongLineIsDroppedWhole() {
  std::string junk(kMaxLine + 20, 'X');
  junk += "\nSTOP\n";
  LineAssembler a;
  std::vector<std::string> lines;
  a.pushBlock(junk.data(), junk.size(), collect, &lines);
  CHECK(lines.size() == 1);
  CHECK_STR(lines[0].c_str(), "STOP");   // resync on the next line
  CHECK(a.overflows() == 1);
}

static void testParseVerbOnly() {
  Command c;
  CHECK(parseCommand("stop", &c));
  CHECK_STR(c.verb(), "STOP");
  CHECK(c.argc() == 0);
  CHECK(c.isVerb("Stop"));
  CHECK(!c.isVerb("STO"));
  CHECK(!c.isVerb("STOPP"));
}

static void testParseArgs() {
  Command c;
  CHECK(parseCommand("ARCADE: 50 , -25 ", &c));
  CHECK_STR(c.verb(), "ARCADE");
  CHECK(c.argc() == 2);
  int v = 0;
  CHECK(c.getInt(0, &v) && v == 50);
  CHECK(c.getInt(1, &v) && v == -25);
  CHECK(c.intOr(7, 99) == 99);           // missing argument -> fallback
}

static void testStrictIntegers() {
  Command c;
  CHECK(parseCommand("DRIVE:5x", &c));
  int v = 123;
  CHECK(!c.getInt(0, &v));               // not silently 5
  CHECK(v == 123);
  CHECK(c.intOr(0, -1) == -1);

  CHECK(parseCommand("DRIVE:", &c));
  CHECK(c.argc() == 1);
  CHECK(!c.getInt(0, &v));               // empty argument is not 0
}

static void testClamping() {
  Command c;
  int v = 0;
  CHECK(parseCommand("DRIVE:900", &c));
  CHECK(c.getIntClamped(0, -100, 100, &v) && v == 100);
  CHECK(parseCommand("DRIVE:-900", &c));
  CHECK(c.getIntClamped(0, -100, 100, &v) && v == -100);
}

static void testRejects() {
  Command c;
  CHECK(!parseCommand("", &c));
  CHECK(!parseCommand("   ", &c));
  CHECK(!parseCommand(":50", &c));                      // no verb
  CHECK(!parseCommand("DRIVE:1,2,3,4,5", &c));          // too many args
  std::string longVerb(kMaxVerb + 1, 'V');
  CHECK(!parseCommand(longVerb.c_str(), &c));
}

static void testChecksum() {
  Command c;
  char buf[64];
  const char* argv[] = {"50"};
  size_t n = formatCommandChecked(buf, sizeof buf, "drive", argv, 1);
  CHECK(n > 0);
  CHECK(buf[n - 1] == '\n');

  std::string line(buf, n - 1);          // strip newline, as the assembler does
  CHECK(parseCommand(line.c_str(), &c));
  CHECK_STR(c.verb(), "DRIVE");
  CHECK(c.intOr(0, 0) == 50);

  line[line.size() - 1] = (line[line.size() - 1] == '0') ? '1' : '0';
  CHECK(!parseCommand(line.c_str(), &c));  // corrupted checksum is rejected
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
struct Bot {
  int left, right;
  int stops;
  int unknowns;
  Bot() : left(0), right(0), stops(0), unknowns(0) {}
};

static void onDrive(const Command& c, void* ctx) {
  Bot* b = static_cast<Bot*>(ctx);
  int v = 0;
  if (c.getIntClamped(0, -100, 100, &v)) b->left = b->right = v;
}
static void onArcade(const Command& c, void* ctx) {
  Bot* b = static_cast<Bot*>(ctx);
  c.getIntClamped(0, -100, 100, &b->left);
  c.getIntClamped(1, -100, 100, &b->right);
}
static void onStop(const Command&, void* ctx) {
  Bot* b = static_cast<Bot*>(ctx);
  b->left = b->right = 0;
  ++b->stops;
}
static void onUnknown(const Command&, void* ctx) {
  ++static_cast<Bot*>(ctx)->unknowns;
}

static void testRouter() {
  Bot bot;
  CommandRouter r;
  LineAssembler a;
  r.on("DRIVE", onDrive);
  r.on("arcade", onArcade);          // registration is case-insensitive too
  r.on("STOP", onStop);
  r.onUnknown(onUnknown);

  const char* stream[] = {"DRI", "VE:50\nARCA", "DE:20,-2", "0\nWAT\nstop\n"};
  for (size_t i = 0; i < 4; ++i) r.feed(stream[i], strlen(stream[i]), &a, &bot);

  CHECK(bot.left == 0 && bot.right == 0);
  CHECK(bot.stops == 1);
  CHECK(bot.unknowns == 1);

  // Replay without the trailing STOP to observe the intermediate state.
  Bot b2;
  LineAssembler a2;
  const char* s2[] = {"DRIVE:50\nARCADE:20,-20\n"};
  r.feed(s2[0], strlen(s2[0]), &a2, &b2);
  CHECK(b2.left == 20 && b2.right == -20);
}

static void testFormat() {
  char buf[64];
  const char* argv[] = {"20", "-20"};
  size_t n = formatCommand(buf, sizeof buf, "arcade", argv, 2);
  CHECK(n > 0);
  CHECK_STR(buf, "ARCADE:20,-20\n");

  CHECK(formatCommand(buf, 4, "arcade", argv, 2) == 0);   // does not fit
  const char* bad[] = {"1,2"};
  CHECK(formatCommand(buf, sizeof buf, "X", bad, 1) == 0); // arg would reframe
}

// A byte-for-byte fuzz-ish check: whatever the chunk boundaries, the same
// stream must yield the same lines.
static void testChunkingIsIrrelevant() {
  const std::string stream =
      "DRIVE:50\nSTOP\nARCADE:10,20\nJUNKJUNK\nDRIVE:-5\n";
  std::vector<std::string> reference;
  {
    LineAssembler a;
    a.pushBlock(stream.data(), stream.size(), collect, &reference);
  }
  for (size_t split = 1; split < stream.size(); ++split) {
    LineAssembler a;
    std::vector<std::string> got;
    a.pushBlock(stream.data(), split, collect, &got);
    a.pushBlock(stream.data() + split, stream.size() - split, collect, &got);
    CHECK(got == reference);
  }
}

int main() {
  testFragmentation();
  testMultipleLinesInOneChunk();
  testPartialTailIsHeld();
  testCrLfAndBlankLines();
  testOverlongLineIsDroppedWhole();
  testParseVerbOnly();
  testParseArgs();
  testStrictIntegers();
  testClamping();
  testRejects();
  testChecksum();
  testRouter();
  testFormat();
  testChunkingIsIrrelevant();

  printf("%d checks, %d failures\n", g_checks, g_failures);
  return g_failures == 0 ? 0 : 1;
}
