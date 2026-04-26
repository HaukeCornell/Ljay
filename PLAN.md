# Ljay — Live DJ Lyrics Karaoke Visualizer

A plugin/companion app that overlays time-synced lyrics and VJ-style audio-reactive visuals on top of whatever a DJ plays — in Traktor, Serato, Rekordbox, or Djay Pro — and stays glued to the music when the DJ skims, pitches, scratches, or loops.

This document is the build plan: product shape, architecture, integration matrix, sync strategy, visuals, agent/AI role, milestones, risks, and a pricing/go-to-market sketch.

---

## 1. Product shape

**Form factor:** standalone desktop app (macOS first, Windows second) that:

1. Detects what is currently playing on the DJ rig (via DJ-software integration *or* audio capture).
2. Fetches/aligns lyrics for that track.
3. Renders a fullscreen output window — designed to be sent to a projector / LED wall / NDI / Syphon — combining audio-reactive visuals + karaoke lyrics.
4. Exposes a separate **operator window** (think OBS / Resolume) for the DJ or a dedicated VJ to tweak visuals, pick lyric styles, override sync, mute/show lyrics, etc.

**"Plugin" framing:** for v1 it is *not* a Traktor/Serato/Rekordbox plugin in the technical sense (those SDKs are closed or hostile). It is a **companion app** that integrates over the integration surfaces those tools already expose (network protocols, MIDI, file watching, audio capture). The word "plugin" in the marketing copy means "drop-in for your booth."

**Core promise:** *plug it in, it just works during your set, no babysitting.*

---

## 2. The four input surfaces (track ID + position)

Every feature downstream depends on knowing:
- **What track is playing** on each deck.
- **Where in the track** the playhead is, in real time, including pitch/tempo and direction.

The matrix below is the foundation. Each DJ app gets a *primary* integration and an *audio-capture fallback*.

| DJ software | Best integration surface | What you get | Reliability |
|---|---|---|---|
| **Rekordbox** (CDJs / XDJ / laptop) | **Pro DJ Link / StagelinQ** over local network (used by hardware CDJs and rekordbox itself when on the network). Open-source libs: `prolink-connect` (Node), `python-prodj-link`, `pioneer-djm-controller`. Gives track metadata, BPM, beat grid, current playhead position, master deck. | Track title/artist + millisecond-accurate position + beatgrid. | High. Used by lighting/visual rigs already (Resolume, MixMeister). |
| **Serato DJ Pro** | No public protocol. Options: (a) read Serato's writable history file (`~/Music/_Serato_/History/`) for now-playing — laggy. (b) Reverse-engineered **Serato Live Playlists** posts to serato.com (also laggy). (c) Capture audio out + fingerprint. (d) Beatport DJ-style **MIDI clock + track-load message** if user maps it. | Track ID OK, position is hard. Best path: audio capture + fingerprint + cue-point inference. | Medium. |
| **Traktor Pro** | **Broadcast/Icecast** out gives audio with metadata (Now Playing strings). Also supports **Ableton Link** for tempo, and **OSC via 3rd-party scripts**. Dedicated controller mappings can MIDI-out track load events. Traktor's `collection.nml` is XML and parseable. | Track ID via metadata stream + tempo via Link. Position needs audio analysis. | Medium-high. |
| **Djay Pro (Algoriddim)** | Has an **AppleScript / URL scheme** on macOS, plus exports MIDI/Ableton Link. Spotify tracks have Spotify track IDs — *huge* for lyrics (Spotify ships synced lyrics via Musixmatch). | Track ID + Spotify URI when available + tempo. | High on macOS. |
| **Universal fallback (any software, incl. vinyl)** | Loopback audio capture (BlackHole on macOS, VB-Cable on Windows) → fingerprint → continuous beat tracking. | Track ID + approximate position. | Always-on safety net. |

**Implication:** the app must be built around an abstraction:

```
TrackSource → emits { deckId, track: {title, artist, isrc?, spotifyId?, durationMs}, positionMs, tempoBpm, pitchRatio, isPlaying, masterDeckId }
```

…with concrete implementations per DJ app, plus an `AudioCaptureSource`. Everything downstream (lyrics, visuals, sync) consumes that abstract event stream.

---

## 3. Track identification

Two-stage:

1. **Primary ID** — from the DJ software's integration (title/artist string, sometimes ISRC or Spotify URI). Cleanest path.
2. **Fingerprint fallback** — when primary fails or is ambiguous (covers, edits, mashups, vinyl, white-labels):
   - **AcoustID / Chromaprint** — open-source, free, large catalog. Returns MusicBrainz IDs.
   - **ACRCloud** — commercial, Shazam-quality. Per-call pricing. Best for mashups.
   - **AudD** — cheaper alternative to ACRCloud.
   - **Apple ShazamKit** — free on macOS/iOS, Apple-only.
   - **Roll-your-own**: not worth it for v1.

Strategy: **AcoustID first** (free, decent hit rate on commercial tracks); if no match in 3s, fall back to **ShazamKit on macOS** or **ACRCloud on Windows/cross-platform**. Cache aggressively per deck — only re-ID when a track-load event fires.

For mashups/edits, fingerprinting will fail. That's okay — the operator can manually attach lyrics or hit "no lyrics" and fall back to pure-visual mode.

---

## 4. Lyrics acquisition

Tiered, all hidden behind a single `LyricsResolver` interface:

| Tier | Source | Format | Notes |
|---|---|---|---|
| 1 | **LRCLIB** (free, community) | Synced LRC / enhanced LRC (word-level) | Surprisingly good coverage on popular tracks. Free. Start here. |
| 2 | **Musixmatch API** (paid) | Synced (line-level) | Industry standard. License covers commercial use. Required for real product. |
| 3 | **Spotify API** (when track has Spotify URI from Djay Pro) | Word-level synced (Musixmatch under the hood) | Best quality. Limited to Spotify tracks. |
| 4 | **Genius** | Plain text only, no timing | Use as text source for AI alignment when no synced lyrics exist. |
| 5 | **AI alignment fallback** | Whisper / WhisperX forced alignment | When only plain text exists, run forced alignment offline against the track's audio file (or live capture) to generate LRC. |
| 6 | **Live ASR** | Whisper-streaming or `faster-whisper` | When *no* lyrics exist anywhere. Lower quality but works on white-labels and improvised tracks. |

**Pre-buffering agent (this is where AI/agents earn their keep):**

When the DJ loads tracks into a playlist *before* the gig, an **Agent** runs:
1. For each track in the prepared playlist:
   - Resolve lyrics through tiers 1→4.
   - If no synced lyrics, kick off a **WhisperX forced alignment job** in the background (needs the audio file; possible when DJ uses local files, harder for streaming).
   - Cache the resulting LRC + a precomputed "lyric scene" (per-line metadata, font sizing, suggested visual preset).
2. Surface a UI: *"42 of 50 tracks have synced lyrics. 6 will use AI alignment. 2 are instrumentals."*

This is the moment AI agents shine — it parallelizes well, can use web search to disambiguate weird remix titles, and the work fits the "do this overnight" cadence of DJ prep.

**Live fallback agent:** during the set, if a track loads with no cached lyrics, a smaller agent fires: ID via fingerprint → web-search lyrics → run forced alignment against the live capture → emit LRC within ~10–20 seconds. Late lyrics are better than no lyrics.

---

## 5. Sync engine — the hard part

Goal: keep the rendered lyric line ±100ms accurate to the audio, even when the DJ scrubs, pitches ±8%, or loops.

Three signals to fuse:

1. **Authoritative position** from DJ software (Pro DJ Link, Djay Pro, etc.) — when available, this is ground truth. Apply pitch ratio to LRC timestamps and render.
2. **Beat tracking** on captured audio (`librosa`, `madmom`, or BTrack) — gives BPM + downbeat phase. Not enough alone, but excellent for catching pitch changes when DJ software gives you tempo only.
3. **Live ASR alignment** — run a fast Whisper variant (`faster-whisper`, `whisper.cpp` on Metal) on a 5–10s rolling buffer; align decoded words against the LRC's known text via dynamic-time-warp. This corrects drift and handles stems/acapella drops.

**Fusion:** Kalman-style state estimator with `positionMs` as the state, the three signals as observations weighted by trust:
- DJ-software position: weight ~0.9 (fast correction).
- Beat tracker phase: weight ~0.3 (smooth tempo follow).
- ASR-LRC alignment: weight ~0.5 with high latency (drift correction every few seconds).

**Scrub/seek detection:** when DJ-software position jumps by >500ms, blow away the smoothing state and re-acquire. Rendering side cross-fades lyric lines to hide the jump.

**MVP simplification:** for v0.1, *only* implement (1) for Rekordbox + Djay Pro and skip the fusion engine. That alone is demoable. Build the fusion only when Serato/Traktor or audio-capture mode go live.

---

## 6. Visual engine

Two render layers, composited:

### 6.1 Audio-reactive background

- **WebGL2 / WebGPU** via `three.js` is the pragmatic choice if the app is Electron/Tauri.
- For maximum street cred and Winamp DNA: ship **butterchurn** (Milkdrop preset format, JS port) as one of the visualizer engines. Thousands of free presets exist. This *immediately* gives the app a 90s-visualizer aesthetic + a huge preset library.
- Add a **hand-built shader pack** (GLSL) in addition: a dozen signature looks (3D tunnel, fluid sim, raymarched landscape, plasma, particle galaxy, vector-field smoke). Each one tagged with vibe metadata: `dark/dreamy`, `peak-time`, `disco`, etc.
- Pipe FFT bins, beat events, and onset detection into uniforms — every shader gets `uBass`, `uMid`, `uTreble`, `uBeat`, `uTempo`, `uTime`.

### 6.2 Lyric layer

Separate scene graph on top:

- Karaoke modes: **line scroll** (current + next), **bouncing ball**, **typewriter**, **word highlight** (per-word timing if available), **big subtitle**.
- Typography presets: chrome bevel, neon, glitch, VHS, brutalist sans, custom user font.
- Animations: fly-in, kerned bounce per beat, glitch-on-drop.
- Composited with shader BG via blend modes (additive, screen, multiply).

### 6.3 Output paths

The output window must support pro DJ/VJ workflows:

- **Fullscreen second-display output** (default).
- **Syphon** (macOS) and **Spout** (Windows) — lets Resolume / MadMapper / TouchDesigner pull the feed.
- **NDI** — network video, used by big VJ rigs.
- **Virtual webcam** — for streamers (OBS Virtual Cam pattern).

Three of the four are MVP-skippable; ship Syphon early because that's what Mac VJs ask for first.

### 6.4 Operator UI (the VJ window)

- Live preset switcher (XY pad, hotkeys, MIDI-mappable).
- Lyrics show/hide, opacity, style override.
- Manual sync nudge (±50ms, ±100ms, ±1 beat).
- Per-track override: pin a visual preset + lyric style to a track ID; persists.
- "Auto-VJ" toggle: an agent picks visuals based on track tags (genre, energy from Spotify audio-features API or self-computed).

---

## 7. Architecture

```
┌─────────────────────── Ljay App (Tauri/Electron) ───────────────────────┐
│                                                                          │
│  [Track Sources]                  [Lyrics + Sync]            [Renderer]  │
│                                                                          │
│  ProDJLinkSource ──┐                                                     │
│  SeratoSource    ──┤                                                     │
│  TraktorSource   ──┼──► TrackBus ──► LyricsResolver ──► SyncEngine ──┐  │
│  DjayProSource   ──┤      │              │                  │        │  │
│  AudioCapture    ──┘      │              │                  │        │  │
│                            │              │                  │        ▼  │
│                            │              │                  │   RenderGraph
│                            ▼              ▼                  ▼        │  │
│                        SetlistStore   LyricsCache       SyncStore  ───┘  │
│                                                                          │
│  [Agent runtime]                                                         │
│  - prep agent (overnight): walk setlist, fetch+align, fill caches        │
│  - live id agent: fingerprint+lookup unknown tracks                      │
│  - auto-VJ agent: pick presets per track                                 │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
                                  │
                       Output: Syphon/Spout/NDI/HDMI
```

### Stack recommendation

- **Shell:** **Tauri** (Rust + webview). Lighter than Electron, lower-latency audio via Rust crates, shippable signed binaries.
- **Renderer:** TypeScript + WebGL2/WebGPU (`three.js` + `butterchurn`). The webview *is* the renderer.
- **Audio + DSP:** Rust crates — `cpal` for capture, `rustfft`, `aubio-rs` for onset/beat. `whisper.cpp` via Rust binding for on-device ASR (Metal acceleration on Mac).
- **DJ integrations:**
  - Pro DJ Link: port of `prolink-connect` to Rust *or* wrap the Node lib in a sidecar.
  - Djay Pro: AppleScript bridge + Ableton Link via `link-rs`.
  - Traktor: parse broadcast metadata + Link.
  - Serato: file-watch + audio fallback.
- **Agent runtime:** Claude / Anthropic SDK with prompt caching (this is a long-running, per-track repetitive task — caching the system prompt across all tracks in a setlist saves real money).
- **Storage:** SQLite via `sqlx` for setlists, lyrics cache, preset library.

### Why not pure web

Latency, output protocols (Syphon/NDI), audio capture from system devices, on-device Whisper. All hit walls in a browser. Tauri keeps the UI web while letting the hard stuff live in Rust.

---

## 8. Where AI / agents fit

Be specific — "use AI" is too vague to ship. Concrete deployments:

1. **Setlist prep agent** (offline, overnight). Inputs: a list of `{title, artist}` from the DJ's playlist export (Rekordbox XML, Serato crate, Djay Pro library). For each track, parallel-fan-out:
   - Lyrics resolution (tier 1→4).
   - Forced alignment if needed.
   - Genre/energy/vibe tagging (call out to Spotify audio-features when ID known; otherwise classify locally).
   - Suggest 3 visual presets per track.
   Use **Claude with prompt caching** — the system prompt + per-track tool descriptions are cached, so each track is just a small marginal call. This is exactly the workload prompt caching is built for.

2. **Live unknown-track agent** (online, fast). Triggered when a deck loads a track with no cache hit. Fingerprint → web search for lyrics → quick alignment → emit. Budget: 15s.

3. **Auto-VJ agent** (online, ambient). Watches the deck stream; when a new track starts, picks a visual preset from the user's library that matches vibe + energy. Easy to demo, easy to disable.

4. **Lyric cleanup / translation agent** (offline). Strips ad-libs noise, optionally translates for non-English crowds, marks censored lines.

5. **Operator copilot** (interactive). "Make it darker for the next 10 mins." → adjusts preset weights and color temperature on the live render. Lower priority for v1.

**Anti-pattern to avoid:** running an LLM on the per-frame critical path. Anything with a sub-100ms requirement is DSP, not LLM.

---

## 9. Milestones

### M0 — One-laptop walkthrough demo (week 1–3)

- Tauri shell with operator + output windows.
- Djay Pro source (because that's what Hauke owns) reading current track via AppleScript.
- LRCLIB lyrics fetch + simple line-scroll renderer.
- One butterchurn preset, one custom shader, FFT-driven from BlackHole loopback.
- Output: HDMI fullscreen, no Syphon yet.

**Demo target:** Hauke's own DJ set. If it survives one full set, it's real.

### M1 — Rekordbox + friends gig (week 4–8)

- Pro DJ Link integration (most professional friends use CDJs with Rekordbox).
- Setlist prep agent (Claude) — DJ exports an XML, app overnight-builds the lyric+visual cache.
- Sync nudge controls + per-track preset pinning.
- 10 hand-built shaders + butterchurn pack.
- Syphon output.

**Demo target:** one paid DJ friend's gig. Watch from the back. Note every glitch.

### M2 — Serato + Traktor + audio-capture fallback (week 9–14)

- AcoustID + ShazamKit fallback path.
- Sync fusion engine (DJ position + beat tracker + WhisperX drift correction).
- Forced-alignment for tracks without synced lyrics (offline).
- Operator UI polish, MIDI mapping for hotkeys, NDI/Spout.

### M3 — Sellable beta (week 15–22)

- Musixmatch commercial license.
- Code signing, auto-update, license-key gating.
- Onboarding: "drop your Rekordbox XML here."
- Crash reporting (Sentry), analytics (privacy-respecting).
- Docs site + 90s product video.

### M4 — v1.0 launch

- Pricing tiers (see §11).
- Paid landing page, Stripe.
- Cold outreach to VJ/DJ communities (DJTechTools, /r/Beatmatch, We Are The Music Makers Discord, NI forum, Resolume forum).

---

## 10. Risks and where to validate fast

| Risk | Why it matters | Cheapest test |
|---|---|---|
| **Lyrics licensing.** Showing synced lyrics commercially without a deal is legally exposed. | Could kill the product before launch. | Read Musixmatch developer terms, email their licensing team early — *before* writing code. LRCLIB is fine for prototype but not commercial use. |
| **Sync precision in messy mixes.** When a DJ loops 4 bars or scratches, lyrics will go off. | Demos die on stage. | Build the sync fusion engine *before* polishing visuals. Test on YouTube DJ-set recordings (free corpus) before live gigs. |
| **Serato has no good integration.** | Serato is huge in hip-hop / scratch DJ scene. | Write the audio-capture-only mode early; if it works for Serato it's the universal fallback. |
| **CPU/GPU budget.** Whisper + shaders + FFT + UI on a DJ's already-loaded laptop. | Crashing in a booth ends the relationship. | Ship a "lite mode" toggle; profile on a mid-tier 2020 MacBook Pro, not Hauke's M-series. |
| **Plugin SDK FOMO.** Pioneer/NI/Serato may eventually open up. | Don't waste months on reverse engineering if a real SDK is coming. | Watch their changelogs; design the `TrackSource` abstraction so a future SDK is just one more impl. |
| **Agent cost.** If overnight prep costs $5/setlist, DJs won't buy. | Margin killer. | Use Claude prompt caching aggressively; cap per-setlist agent budget; let users plug in their own API key in advanced mode. |

---

## 11. Pricing / go-to-market sketch (preliminary)

- **Free tier:** community lyrics (LRCLIB), 3 visual presets, Djay Pro + Rekordbox sources, watermark on output.
- **Pro ($15–25/mo or $200/yr):** Musixmatch lyrics, full preset library, Syphon/NDI/Spout, MIDI mapping, prep agent.
- **Studio (one-time $400+):** offline alignment, custom shader import, multi-machine licensing for VJ rigs.
- **Hardware bundle (long shot):** USB dongle preloaded for plug-and-play in DJ booths — tactile + giftable + harder to pirate.

Distribution: own site + Gumroad mirror. App Store is hostile to networked DJ tools.

---

## 12. Immediate next steps (this week)

1. **Stand up the repo:** Tauri scaffold, TS+Rust, basic dual-window shell.
2. **Pick one source first:** Djay Pro AppleScript probe — confirm you can read current track + position reliably.
3. **Wire LRCLIB:** fetch synced lyrics for the current track, log to console.
4. **Render a single karaoke line** in the output window with butterchurn behind it.
5. **Email Musixmatch** for a developer/commercial conversation — long lead time on licensing.
6. **Pull a Rekordbox XML** from a DJ friend (they all have one) — that single file is the seed for the prep-agent demo.

If you can do (1)–(4) end-to-end on a single track in week one, the rest of the plan unlocks.

---

## 13. Open questions to decide before coding

- **Output window:** strict 1080p/4K fixed canvas, or arbitrary projector resolution?
- **Operator window:** native (Tauri) or web-based (so VJ can run it on iPad over LAN)? An iPad operator panel is a real selling point.
- **Cloud component:** any? (Lyrics cache, telemetry, license check.) Or strictly local with a bring-your-own-API-key model? Local-first is the safer brand for the booth.
- **Multi-deck behavior:** master deck only, or crossfade-aware mix of two lyric streams? Crossfade-aware is *very* cool but engineering-heavy. Master-deck-only for MVP.
- **Vinyl / mashup gracefully:** when nothing IDs, do we go pure-visual (no lyrics) or show a "?" placeholder? Pure-visual is the right brand answer.

Decide each before opening the file.
