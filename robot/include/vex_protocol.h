// vex_protocol.h - framing + parsing for the VEX IQ <-> browser serial link.
//
// The link is a Bluetooth virtual COM port, so bytes arrive in arbitrary
// chunks: "DRI", "VE:5", "0\nSTOP\n" is a perfectly normal sequence. Nothing
// here assumes a read returns a whole line.
//
// Wire format (both directions):
//
//     VERB[:arg[,arg...]][*HH]\n
//
//   VERB  ASCII, case-insensitive, normalised to upper case.
//   arg   free-form token, leading/trailing spaces trimmed.
//   *HH   optional XOR checksum of every byte before the '*', two hex digits.
//         When present it is verified; when absent the line is accepted.
//
// Examples:  STOP\n   DRIVE:50\n   ARCADE:50,-25\n   DRIVE:50*1B\n
//
// No dynamic allocation: every buffer is fixed size and lives in the object.

#ifndef VEX_PROTOCOL_H
#define VEX_PROTOCOL_H

#include <stddef.h>

namespace proto {

// Tunables. Lines longer than kMaxLine are dropped, not truncated-and-parsed,
// so a garbled burst can never be mistaken for a valid short command.
static const size_t kMaxLine = 96;
static const size_t kMaxArgs = 4;
static const size_t kMaxVerb = 16;
static const size_t kMaxArg  = 24;

// ---------------------------------------------------------------------------
// LineAssembler: bytes in, complete lines out.
// ---------------------------------------------------------------------------
class LineAssembler {
 public:
  LineAssembler();

  // Feed one byte. Returns true when a complete line is ready; the line
  // (without its terminator, never longer than kMaxLine) is then readable via
  // line() until the next push() call.
  bool push(char c);

  // Feed a block. Calls sink(line, ctx) once per complete line found.
  typedef void (*LineSink)(const char* line, void* ctx);
  void pushBlock(const char* data, size_t len, LineSink sink, void* ctx);

  const char* line() const { return line_; }
  size_t lineLength() const { return line_len_; }

  // Count of lines dropped because they exceeded kMaxLine. Useful telemetry:
  // a non-zero value means the peer is out of sync or the link is corrupting
  // bytes, which is otherwise invisible.
  unsigned long overflows() const { return overflows_; }

  void reset();

 private:
  char  buf_[kMaxLine + 1];
  size_t len_;
  bool  discarding_;      // current line already too long: skip to next '\n'

  char  line_[kMaxLine + 1];
  size_t line_len_;

  unsigned long overflows_;

  bool commit();
};

// ---------------------------------------------------------------------------
// Command: one parsed line.
// ---------------------------------------------------------------------------
class Command {
 public:
  Command();

  const char* verb() const { return verb_; }
  size_t argc() const { return argc_; }
  const char* arg(size_t i) const;

  // Strict integer accessors. getInt returns false if the argument is missing
  // or is not a complete, well-formed integer ("5x" and "" both fail), so a
  // corrupted argument can never silently become 0.
  bool getInt(size_t i, int* out) const;
  int  intOr(size_t i, int fallback) const;

  // Same, clamped to [lo, hi]. Out-of-range values are clamped, not rejected.
  bool getIntClamped(size_t i, int lo, int hi, int* out) const;

  bool isVerb(const char* v) const;

  void clear();

  friend bool parseCommand(const char* line, Command* out);

 private:
  char   verb_[kMaxVerb + 1];
  char   args_[kMaxArgs][kMaxArg + 1];
  size_t argc_;
};

// Parse one assembled line. Returns false for blank lines, lines whose verb or
// arguments overflow their limits, and lines with a bad checksum.
bool parseCommand(const char* line, Command* out);

// ---------------------------------------------------------------------------
// CommandRouter: verb -> handler table.
// ---------------------------------------------------------------------------
class CommandRouter {
 public:
  typedef void (*Handler)(const Command& cmd, void* ctx);

  CommandRouter();

  // Registers (or replaces) a handler. Returns false only if the table is full.
  bool on(const char* verb, Handler h);

  // Handler invoked for a well-formed command with no registered verb.
  void onUnknown(Handler h) { unknown_ = h; }

  bool dispatch(const Command& cmd, void* ctx);

  // Convenience: assemble, parse and dispatch in one call.
  void feed(const char* data, size_t len, LineAssembler* asm_, void* ctx);

 private:
  static const size_t kMaxRoutes = 16;
  struct Route {
    char    verb[kMaxVerb + 1];
    Handler handler;
  };
  Route  routes_[kMaxRoutes];
  size_t count_;
  Handler unknown_;
};

// ---------------------------------------------------------------------------
// Outbound helpers.
// ---------------------------------------------------------------------------

// Formats "VERB:a,b\n" into out. argv may be NULL when argc is 0. Returns the
// number of bytes written, or 0 if it would not fit.
size_t formatCommand(char* out, size_t cap, const char* verb,
                     const char* const* argv, size_t argc);

// Same, with a trailing "*HH" checksum before the newline.
size_t formatCommandChecked(char* out, size_t cap, const char* verb,
                            const char* const* argv, size_t argc);

// XOR of every byte in s. Exposed for tests and for framing telemetry.
unsigned char checksum(const char* s, size_t len);

}  // namespace proto

#endif  // VEX_PROTOCOL_H
