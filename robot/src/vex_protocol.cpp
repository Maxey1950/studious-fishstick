#include "vex_protocol.h"

#include <string.h>

namespace proto {
namespace {

inline bool isSpace(char c) {
  return c == ' ' || c == '\t' || c == '\v' || c == '\f';
}

inline char upper(char c) {
  return (c >= 'a' && c <= 'z') ? static_cast<char>(c - 'a' + 'A') : c;
}

int hexVal(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

// Copies [begin, end) into dst, trimming surrounding whitespace and
// upper-casing when asked. Returns false if it does not fit.
bool copyToken(char* dst, size_t cap, const char* begin, const char* end,
               bool toUpper) {
  while (begin < end && isSpace(*begin)) ++begin;
  while (end > begin && isSpace(*(end - 1))) --end;
  size_t n = static_cast<size_t>(end - begin);
  if (n > cap) return false;
  for (size_t i = 0; i < n; ++i) {
    dst[i] = toUpper ? upper(begin[i]) : begin[i];
  }
  dst[n] = '\0';
  return true;
}

bool parseIntStrict(const char* s, int* out) {
  if (s == 0 || *s == '\0') return false;
  bool neg = false;
  if (*s == '+' || *s == '-') {
    neg = (*s == '-');
    ++s;
    if (*s == '\0') return false;
  }
  long v = 0;
  for (; *s; ++s) {
    if (*s < '0' || *s > '9') return false;
    v = v * 10 + (*s - '0');
    if (v > 2147483647L) return false;  // saturate rather than wrap
  }
  *out = static_cast<int>(neg ? -v : v);
  return true;
}

}  // namespace

unsigned char checksum(const char* s, size_t len) {
  unsigned char x = 0;
  for (size_t i = 0; i < len; ++i) x ^= static_cast<unsigned char>(s[i]);
  return x;
}

// ---------------------------------------------------------------------------
// LineAssembler
// ---------------------------------------------------------------------------

LineAssembler::LineAssembler()
    : len_(0), discarding_(false), line_len_(0), overflows_(0) {
  buf_[0] = '\0';
  line_[0] = '\0';
}

void LineAssembler::reset() {
  len_ = 0;
  discarding_ = false;
  line_len_ = 0;
  buf_[0] = '\0';
  line_[0] = '\0';
}

bool LineAssembler::commit() {
  memcpy(line_, buf_, len_);
  line_[len_] = '\0';
  line_len_ = len_;
  len_ = 0;
  buf_[0] = '\0';
  return line_len_ > 0;
}

bool LineAssembler::push(char c) {
  // Accept both LF and CRLF, and treat a bare CR as a terminator too: some
  // terminal emulators on the far end send only CR.
  if (c == '\n' || c == '\r') {
    if (discarding_) {
      discarding_ = false;
      len_ = 0;
      return false;  // the overflowed line ends here and is thrown away
    }
    if (len_ == 0) return false;  // blank line (or the LF of a CRLF pair)
    return commit();
  }

  if (discarding_) return false;

  if (len_ >= kMaxLine) {
    // Drop the whole line rather than parsing a truncated prefix.
    discarding_ = true;
    len_ = 0;
    ++overflows_;
    return false;
  }

  buf_[len_++] = c;
  return false;
}

void LineAssembler::pushBlock(const char* data, size_t len, LineSink sink,
                              void* ctx) {
  for (size_t i = 0; i < len; ++i) {
    if (push(data[i]) && sink != 0) sink(line_, ctx);
  }
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

Command::Command() { clear(); }

void Command::clear() {
  verb_[0] = '\0';
  argc_ = 0;
  for (size_t i = 0; i < kMaxArgs; ++i) args_[i][0] = '\0';
}

const char* Command::arg(size_t i) const {
  return i < argc_ ? args_[i] : "";
}

bool Command::getInt(size_t i, int* out) const {
  if (i >= argc_ || out == 0) return false;
  return parseIntStrict(args_[i], out);
}

int Command::intOr(size_t i, int fallback) const {
  int v = 0;
  return getInt(i, &v) ? v : fallback;
}

bool Command::getIntClamped(size_t i, int lo, int hi, int* out) const {
  int v = 0;
  if (!getInt(i, &v)) return false;
  if (v < lo) v = lo;
  if (v > hi) v = hi;
  *out = v;
  return true;
}

bool Command::isVerb(const char* v) const {
  if (v == 0) return false;
  size_t i = 0;
  for (; v[i] != '\0' && verb_[i] != '\0'; ++i) {
    if (upper(v[i]) != verb_[i]) return false;
  }
  return v[i] == '\0' && verb_[i] == '\0';
}

bool parseCommand(const char* line, Command* out) {
  if (line == 0 || out == 0) return false;
  out->clear();

  size_t len = strlen(line);

  // Optional "*HH" checksum suffix.
  if (len >= 3 && line[len - 3] == '*') {
    int hi = hexVal(line[len - 2]);
    int lo = hexVal(line[len - 1]);
    if (hi < 0 || lo < 0) return false;
    size_t body = len - 3;
    if (checksum(line, body) != static_cast<unsigned char>(hi * 16 + lo)) {
      return false;
    }
    len = body;
  }

  while (len > 0 && isSpace(line[len - 1])) --len;
  const char* p = line;
  const char* end = line + len;
  while (p < end && isSpace(*p)) ++p;
  if (p == end) return false;

  const char* colon = p;
  while (colon < end && *colon != ':') ++colon;

  if (!copyToken(out->verb_, kMaxVerb, p, colon, true)) return false;
  if (out->verb_[0] == '\0') return false;

  if (colon == end) return true;  // no arguments

  const char* a = colon + 1;
  while (true) {
    const char* comma = a;
    while (comma < end && *comma != ',') ++comma;
    if (out->argc_ >= kMaxArgs) return false;  // too many arguments: reject
    if (!copyToken(out->args_[out->argc_], kMaxArg, a, comma, false)) {
      return false;
    }
    ++out->argc_;
    if (comma == end) break;
    a = comma + 1;
  }
  return true;
}

// ---------------------------------------------------------------------------
// CommandRouter
// ---------------------------------------------------------------------------

CommandRouter::CommandRouter() : count_(0), unknown_(0) {
  for (size_t i = 0; i < kMaxRoutes; ++i) {
    routes_[i].verb[0] = '\0';
    routes_[i].handler = 0;
  }
}

bool CommandRouter::on(const char* verb, Handler h) {
  if (verb == 0 || h == 0) return false;
  size_t n = strlen(verb);
  if (n == 0 || n > kMaxVerb) return false;

  char up[kMaxVerb + 1];
  for (size_t i = 0; i < n; ++i) up[i] = upper(verb[i]);
  up[n] = '\0';

  for (size_t i = 0; i < count_; ++i) {
    if (strcmp(routes_[i].verb, up) == 0) {
      routes_[i].handler = h;  // replace
      return true;
    }
  }
  if (count_ >= kMaxRoutes) return false;
  strcpy(routes_[count_].verb, up);
  routes_[count_].handler = h;
  ++count_;
  return true;
}

bool CommandRouter::dispatch(const Command& cmd, void* ctx) {
  for (size_t i = 0; i < count_; ++i) {
    if (strcmp(routes_[i].verb, cmd.verb()) == 0) {
      routes_[i].handler(cmd, ctx);
      return true;
    }
  }
  if (unknown_ != 0) unknown_(cmd, ctx);
  return false;
}

namespace {
struct FeedCtx {
  CommandRouter* router;
  void* user;
};

void feedSink(const char* line, void* raw) {
  FeedCtx* fc = static_cast<FeedCtx*>(raw);
  Command cmd;
  if (parseCommand(line, &cmd)) fc->router->dispatch(cmd, fc->user);
}
}  // namespace

void CommandRouter::feed(const char* data, size_t len, LineAssembler* asm_,
                         void* ctx) {
  if (asm_ == 0) return;
  FeedCtx fc;
  fc.router = this;
  fc.user = ctx;
  asm_->pushBlock(data, len, feedSink, &fc);
}

// ---------------------------------------------------------------------------
// Outbound helpers
// ---------------------------------------------------------------------------

namespace {

// Writes the body ("VERB:a,b", no newline) and returns its length, or 0 if it
// does not fit in cap bytes (leaving room for the caller's suffix).
size_t formatBody(char* out, size_t cap, const char* verb,
                  const char* const* argv, size_t argc) {
  if (out == 0 || verb == 0 || argc > kMaxArgs) return 0;
  size_t n = 0;
  for (size_t i = 0; verb[i] != '\0'; ++i) {
    if (n + 1 > cap) return 0;
    out[n++] = upper(verb[i]);
  }
  if (n == 0) return 0;
  for (size_t i = 0; i < argc; ++i) {
    if (n + 1 > cap) return 0;
    out[n++] = (i == 0) ? ':' : ',';
    const char* a = argv[i];
    for (size_t j = 0; a != 0 && a[j] != '\0'; ++j) {
      // A raw ',' ':' or newline inside an argument would reframe the line.
      if (a[j] == ',' || a[j] == ':' || a[j] == '\n' || a[j] == '\r') return 0;
      if (n + 1 > cap) return 0;
      out[n++] = a[j];
    }
  }
  return n;
}

}  // namespace

size_t formatCommand(char* out, size_t cap, const char* verb,
                     const char* const* argv, size_t argc) {
  if (cap < 2) return 0;
  size_t n = formatBody(out, cap - 2, verb, argv, argc);  // '\n' + '\0'
  if (n == 0) return 0;
  out[n++] = '\n';
  out[n] = '\0';
  return n;
}

size_t formatCommandChecked(char* out, size_t cap, const char* verb,
                            const char* const* argv, size_t argc) {
  if (cap < 5) return 0;
  size_t n = formatBody(out, cap - 5, verb, argv, argc);  // "*HH\n" + '\0'
  if (n == 0) return 0;
  static const char kHex[] = "0123456789ABCDEF";
  unsigned char x = checksum(out, n);
  out[n++] = '*';
  out[n++] = kHex[(x >> 4) & 0x0F];
  out[n++] = kHex[x & 0x0F];
  out[n++] = '\n';
  out[n] = '\0';
  return n;
}

}  // namespace proto
