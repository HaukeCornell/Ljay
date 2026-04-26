// link_helper.cpp
//
// Long-lived stdin-driven helper that joins an Ableton Link session and
// prints a JSON object per line on stdout in response to "p\n" on stdin.
//
//   "p\n" -> poll once: emit one JSON line  { "bpm": 124.0, "phase": 0.37, "peers": 1, "playing": true }
//   "q\n" -> quit
//
// Build:
//   clang++ -std=c++14 -O2 \
//     -I vendor/link/include \
//     -I vendor/link/extensions/abl_link/include \
//     -I vendor/link/modules/asio-standalone/asio/include \
//     -DLINK_PLATFORM_MACOSX=1 \
//     vendor/link/extensions/abl_link/src/abl_link.cpp \
//     sidecar/link_helper.cpp \
//     -o sidecar/link_helper -framework CoreFoundation
//
// macOS only.

#include "abl_link.h"

#include <atomic>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <iostream>
#include <string>

namespace {

// Quantum in beats — we expose phase mod 4 so a "downbeat" wraps every bar
// for typical 4/4 music. The renderer can also derive a per-beat phase by
// taking fmod(phase, 1.0).
constexpr double QUANTUM_BEATS = 4.0;

abl_link gLink;
abl_link_session_state gState;
std::atomic<bool> gShouldQuit{false};

void writeLine(const std::string& s) {
  // Use stdio so we don't have to flush manually after every line.
  std::fputs(s.c_str(), stdout);
  std::fputc('\n', stdout);
  std::fflush(stdout);
}

void emitEmpty(const char* reason) {
  std::string s = std::string("{\"empty\":true,\"reason\":\"") + reason + "\"}";
  writeLine(s);
}

void pollOnce() {
  abl_link_capture_app_session_state(gLink, gState);
  const int64_t t = abl_link_clock_micros(gLink);
  const double bpm = abl_link_tempo(gState);
  const double phase = abl_link_phase_at_time(gState, t, QUANTUM_BEATS);
  const double beat = abl_link_beat_at_time(gState, t, QUANTUM_BEATS);
  const uint64_t peers = abl_link_num_peers(gLink);
  const bool playing = abl_link_is_playing(gState);

  // Format JSON. Keep it compact.
  char buf[256];
  std::snprintf(buf, sizeof(buf),
    "{\"bpm\":%.4f,\"phase\":%.6f,\"beat\":%.6f,\"quantum\":%.1f,\"peers\":%llu,\"playing\":%s,\"clockMicros\":%lld}",
    bpm, phase, beat, QUANTUM_BEATS,
    static_cast<unsigned long long>(peers),
    playing ? "true" : "false",
    static_cast<long long>(t));
  writeLine(buf);
}

}  // namespace

int main(int /*argc*/, char* /*argv*/[]) {
  // Initial tempo is irrelevant once we join a session — the leader's tempo
  // takes over. Use a sane default.
  gLink = abl_link_create(120.0);
  abl_link_enable(gLink, true);
  // Subscribing to start/stop sync so playing/stopped follows the session
  // (Djay broadcasts this as of Pro 5).
  abl_link_enable_start_stop_sync(gLink, true);
  gState = abl_link_create_session_state();

  // Boot signal so the Node sidecar knows we're alive.
  std::fputs("{\"ready\":true}\n", stderr);
  std::fflush(stderr);

  std::string line;
  while (!gShouldQuit && std::getline(std::cin, line)) {
    // Trim trailing whitespace.
    while (!line.empty() && (line.back() == '\r' || line.back() == ' ' || line.back() == '\t')) {
      line.pop_back();
    }
    if (line == "p") {
      pollOnce();
    } else if (line == "q") {
      gShouldQuit = true;
    }
    // Unknown commands: ignore.
  }

  abl_link_destroy_session_state(gState);
  abl_link_destroy(gLink);
  return 0;
}
