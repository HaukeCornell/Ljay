# Ljay MVP — Djay Pro lyrics visualizer

Scope cut from [PLAN.md](PLAN.md): one DJ source (Djay Pro on macOS), no operator window, no Syphon/NDI, no setlist prep, no Whisper. Just: **DJ plays a song → fullscreen window shows synced lyrics over an audio-reactive vibe.** Two stretch toys we want to prototype on top: **web images per lyric line** and **synced official music videos behind the lyrics**.

---

## 0. The MVP loop in one sentence

Djay Pro tells us *what's playing and where*; LRCLIB gives us *the words and timestamps*; a vibe shader paints the background; a fullscreen window renders the karaoke line.

Everything else in this doc is a layer on that loop.

---

## 1. The Djay Pro source

Djay Pro for Mac exposes its state through several surfaces — we'll use whichever proves most reliable, in this priority:

1. **AppleScript dictionary.** Djay Pro publishes one. From a quick read it exposes per-deck `title`, `artist`, `position` (seconds), `duration`, `bpm`, `playing`, `pitch`. Polling at 30 Hz from a Rust sidecar is cheap and simple. **Verify on day 1** that `position` actually moves smoothly when scratching/pitching, and that two decks are independently reachable.
2. **MIDI / Ableton Link** (if AppleScript position turns out to be coarse). Link gives sub-millisecond tempo phase; combined with a "track loaded" event it's enough to extrapolate position.
3. **Spotify URI.** When a track in Djay was streamed from Spotify, the URI is reachable (likely via AppleScript `spotify id` property — to confirm). This unlocks Spotify's word-level synced lyrics, which are *much* better than line-level LRCLIB.

**Master-deck rule:** we render lyrics for whichever deck has the higher channel fader / crossfader weight. Djay's AppleScript exposes crossfader position. MVP rule: pick the deck with `crossfaderWeight × channelVolume` higher; debounce switches by 1.5s so a quick blend doesn't flash lyrics back and forth.

**Day-1 spike:** before anything else, write a 50-line Rust binary that polls Djay over AppleScript and prints `{deck, title, artist, position, bpm, playing}` ten times a second. If that doesn't work cleanly, the whole MVP changes.

---

## 2. Lyrics

Drop the tiered resolver from PLAN.md for now. MVP uses two sources only:

1. **LRCLIB** (free, line-level synced LRC). Default for all tracks.
2. **Spotify lyrics** (word-level) when Djay reports a Spotify track ID. Note the API for this is not officially documented; community libraries (`syrics`, `spotify-lyrics-api`) work today but are unstable. Treat as a bonus, not a core path.

If neither returns lyrics: render the vibe shader fullscreen, no lyrics. Don't try to be clever in MVP.

**Cache** every fetched LRC to a local SQLite by `(title, artist)` and by Spotify ID. A cold gig is mostly a warm gig from cache by song two.

---

## 3. Sync (MVP simplification)

Just trust Djay's reported position, scaled by pitch. No fusion engine.

```
renderedTimeMs = djayPositionMs   // already accounts for pitch in Djay's clock
currentLine    = lrc.lineAt(renderedTimeMs)
```

Crossfade lyric lines on jumps >300ms. Done. Save the Kalman fusion for v0.2 when we hit the inevitable Djay-says-X-but-audio-says-Y edge case at a real gig.

---

## 4. The "vibe" system

A vibe = a named bundle of `{ shader, palette, tempo-response, lyric font + animation, optional foreground assets }`. MVP ships ~6 hand-tuned vibes:

| Vibe | Shader idea | Lyric style |
|---|---|---|
| **Winamp** | Milkdrop preset (butterchurn) — kaleidoscopic FFT bloom. | Chrome-bevel serif, classic karaoke line scroll. |
| **Tunnel** | Raymarched 3D tunnel, beat-pulsed walls. | Bold sans flying in along Z axis. |
| **VHS** | Scanlines + chromatic aberration over slow color field. | Typewriter caps with magenta/cyan offset. |
| **Disco** | Particle dance floor, mirror-ball specular. | Big disco serif, per-word bounce on beats. |
| **Smoke** | GPU fluid sim, bass-driven dye injection. | Soft handwriting font, fade in/out per line. |
| **Minimal** | Flat solid + subtle grain, palette swap on drop. | Brutalist sans, black & white only. |

Selection in MVP: **one global vibe picker** in a small floating control. No auto-VJ agent yet. We earn the right to auto-VJ once a human can pick fast.

Common shader uniforms wired from a Rust audio-capture thread: `uTime`, `uBpm`, `uBass`, `uMid`, `uTreble`, `uBeatPhase`, `uOnset` (transient flag). Audio comes from BlackHole loopback of the system output.

---

## 5. The two iconic stretch ideas

Both worth prototyping early because they're the difference between "neat" and "people film it on their phones."

### 5.1 Web images per lyric line ("iconic image flash")

The dream: as the line *"diamonds on my neck"* hits, a flash of a real diamond chain appears as a foreground element behind/next to the lyrics.

**Approach (offline-leaning, minimal live cost):**

1. After lyrics resolve for a track, an **agent** runs once per track: for each line, extract 1–2 noun-phrase keywords, hit an image API, pick one image, cache it as part of the lyric scene.
2. Image sources, in order: **Unsplash API** (free tier, license-clean), **Pexels** (also free), **Bing Image Search API** (broader, paid). Avoid scraping Google Images directly — TOS + brittleness.
3. Curation step (also agent): reject NSFW, reject text-heavy stock photos, prefer high-contrast, prefer images that match the vibe's palette (pass palette to the agent prompt).
4. Render: image flashes in for 1.5s when the line starts, with a vibe-matching transition (VHS = roll-in, Minimal = hard cut, Smoke = dissolve). Multiple images per song should stay aesthetically coherent — the agent should be told "you are picking 30 images for one song; keep style consistent."

**Cost note:** this is a perfect prompt-caching workload — the system prompt + style guide + vibe info are constant per song; only the line text changes. Cache the prefix.

**Live-only fallback (skip in MVP, document path):** a tiny on-device image model could pick from a pre-downloaded library of ~5000 themed images per vibe. Fast, no network, but less magical. Worth it if web latency hurts.

**Risk:** image rights at scale. Unsplash/Pexels are commercially OK; Bing is murkier. For the friends-gig MVP this is fine; revisit before paid launch.

### 5.2 Synced official music videos behind lyrics

The dream: the official music video plays behind the lyrics, *frame-locked to the audio the DJ is playing*, even when the DJ pitches +4% or scratches.

This is the hardest thing in either doc. It splits into two problems.

#### A. Acquiring the video

- **Source:** YouTube via `yt-dlp`. Search `"{title} {artist} official video"`, take top hit.
- **Cache:** download the MP4 once, store locally keyed by `(title, artist)`.
- **Background download** as soon as a track loads in *any* deck — DJs pre-cue 30s+ before bringing a track in, so we have time.
- **Legal:** for a friend-gig POC this is fine for personal use; for sale, this is dicey enough that we must offer a "MV mode requires you to bring your own video files" option to insulate the product. Document that decision now, don't surprise legal later.

#### B. Aligning the MV to the audio (the hard part)

The MV's audio and Djay's playing audio are *the same recording* (usually) — but at different positions and tempos. We need a continuous offset.

Two-phase approach:

1. **Coarse alignment (once per track load, ~1s):**
   - Extract a Chromaprint fingerprint from the MV's audio.
   - Cross-correlate against a fingerprint of the live captured audio over the last 5–10s.
   - Result: `videoOffsetMs` such that `mvAudioTime = liveTime + videoOffsetMs`.
2. **Continuous tracking (every frame):**
   - Drive the video element's `currentTime` from `djayPositionMs - videoOffsetMs`.
   - Apply Djay's `pitchRatio` to `playbackRate` (videos can play 0.5–4× without pitch correction; HTML video allows it — quality drops at extremes).
   - On scrub events from Djay, hard-seek the video.
   - On drift > 80ms (measured via periodic re-fingerprint of MV+live), nudge `playbackRate` by ±2% for a few seconds to creep back.

**Edge cases to expect and design around:**

- **Remix/edit:** MV doesn't actually match the audio. Detect via low fingerprint correlation; auto-disable MV and fall back to vibe shader.
- **Scratch:** video can't follow scratching plausibly. On scratch detection (sudden +/− position oscillation), freeze the last frame and apply a glitch shader on top. Way better than chasing.
- **Long mix outs:** as the next track ramps in on the other deck, dissolve to that deck's MV; needs the dual-MV pipeline. **Out of MVP** — render only the master deck's MV.
- **Loop section:** Djay reports the looped position correctly, so the video naturally loops. Confirm.
- **Pitched > ±8%:** at extreme pitch the MV looks/sounds bad. Above ±8%, fall back to muted-MV-frozen-on-beat-grid + vibe shader on top.

**MV is always muted.** The DJ's audio is the only audio. This is non-negotiable.

**Render composition with lyrics:**
- MV → background plane.
- Vibe shader → optional thin compositing layer (chromatic aberration, scanlines, palette tint to match vibe).
- Lyrics → top layer with a backing scrim for readability over busy footage.

**MVP cut for MV mode:** ship a "MV mode (beta)" toggle, only on tracks with cached MP4s, master-deck only, drop out gracefully on scratches. Don't try for perfect; try for "holy shit." Even 80% of the time looking right is the magic.

---

## 6. App shape (MVP)

Single Tauri window for now, two regions:

```
┌────────────────────────────────────────────────────┐
│  [vibe picker] [MV: off/on] [lyrics: on/off] [⚙]   │  ← 40px control bar
├────────────────────────────────────────────────────┤
│                                                    │
│                 fullscreen render                  │
│                 (lyrics + visuals)                 │
│                                                    │
└────────────────────────────────────────────────────┘
```

Press `F` for true fullscreen on the second display. That's the whole UI for MVP.

Stack: Tauri + TS/three.js (renderer) + Rust sidecar (Djay AppleScript polling, audio capture, FFT, yt-dlp invocation, fingerprint matching). SQLite for caches.

---

## 7. Milestones (re-cut for this MVP)

### Week 1 — Spike
- Tauri project scaffolded.
- Rust binary that prints Djay state at 30 Hz.
- Fullscreen window that shows `{title} — {artist}` and the live position bar.
- BlackHole audio capture + FFT → console log of bass/mid/treble.

**Decision gate:** does Djay's AppleScript position move smoothly under scratch/pitch? If no, switch to Link-based extrapolation before continuing.

### Week 2 — Lyrics
- LRCLIB fetcher + SQLite cache.
- Line-scroll renderer (current line big, next line dim).
- Crossfade on line change.
- Manual nudge hotkeys (`[` / `]` for ±50ms).

### Week 3 — Vibes
- butterchurn integration (one preset = "Winamp" vibe).
- Two custom GLSL shaders (Tunnel + Minimal).
- Vibe picker UI + smooth transitions between vibes.
- Lyric font/animation per vibe.

### Week 4 — Friend-gig dress rehearsal
- Test on Hauke's own set end-to-end.
- Fix the top 5 ugly bugs.
- Hand it to one friend with Djay Pro for a low-stakes set.

### Week 5–6 — Image flash prototype
- Per-line image fetch agent (Claude + Unsplash).
- Cache pipeline.
- Render layer with vibe-tuned transitions.
- Toggle on/off in control bar.

### Week 7–8 — MV mode prototype
- yt-dlp download pipeline + cache.
- Chromaprint cross-correlation for offset.
- Pitch-following `playbackRate`.
- Scratch detection → freeze frame.
- "MV mode (beta)" toggle, master-deck only.

After M8, re-evaluate against the broader [PLAN.md](PLAN.md): operator window, Syphon, Rekordbox source, prep agent.

---

## 8. The "do these this week" list

1. Confirm Djay Pro AppleScript actually returns smooth `position` at 30 Hz under pitch + scratch. Write the throwaway probe before anything else. *This decides whether the rest of the plan stands.*
2. Confirm Spotify URI is exposed via AppleScript when the track came from Spotify. If yes, the path to word-level lyrics is open.
3. `brew install blackhole-2ch`, route Djay master out → BlackHole + speakers (multi-output device), confirm audio is capturable from a Rust process via `cpal`.
4. Tauri scaffold, two-process layout (Rust sidecar ↔ TS renderer over events).
5. Email Musixmatch licensing — long lead time, doesn't block code.

If 1–4 are green by end of week, week 2 starts on real ground.

---

## 9. Open MVP-level questions

- **MV mode legality stance:** ship as "user provides their own MP4s" *or* ship with yt-dlp built in and accept the risk for the friends-gig POC? Recommend: yt-dlp for MVP behind a beta flag, switch to BYOMP4 + optional yt-dlp companion before any paid release.
- **Image rights stance for paid:** stick to Unsplash/Pexels only, or layer Bing? Recommend: MVP = Unsplash only (cleanest), expand later.
- **Render canvas size:** lock 1920×1080 internally and letterbox, or match the projector? Recommend: 1080p internal, letterbox. Saves perf headaches.
- **Operator interaction surface:** keyboard hotkeys only, or expose a tiny web server on `localhost:7777` so an iPad can reach it on the same Wi-Fi later? Recommend: build the renderer state behind a small WebSocket from day 1, even if the only client is the same window. Free iPad later.
