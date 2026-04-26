# Ljay — Control Panel & Layered Architecture Brief

**Hand-off doc for the next Claude session.** Covers what Ljay is today, where the complexity is choking us, and what to design next: a remote-control panel (iPad-first) backed by a layered visualization pipeline with per-layer parameters and named presets.

---

## 1. What Ljay is

A live DJ lyric karaoke + VJ visualizer for macOS. The user runs Djay Pro (or any media-key-aware app), Ljay reads what's playing via macOS MediaRemote, fetches synced lyrics from LRCLIB, and renders a fullscreen lyric-aware visual stage you'd project at a gig. Joins Djay's Ableton Link session for sub-millisecond beat sync. Optional music-video overlay via yt-dlp. Audio reactivity via BlackHole loopback (with a synthetic-beat fallback).

**Stack:** Vite + TypeScript + three.js renderer; Node sidecar that bridges a Swift MediaRemote helper and a C++ Ableton Link helper to the renderer over WebSocket on `127.0.0.1:7777`. Same port serves yt-dlp video files via HTTP.

Today: **all logic runs locally**. Renderer in Chrome at `localhost:5173`. Already the WS+HTTP sidecar is set up to serve other clients on the LAN — that's the foothold for the iPad remote.

---

## 2. Feature inventory (every knob currently exposed)

### Vibes (background visualizers — pick one)
File: `src/vibes/<id>.ts`. Registered in `src/vibes/registry.ts`.

| id | name | what it is |
|---|---|---|
| `flythrough` | Fly-through | Tron grid floor + warp star streaks + 3D extruded text words flying through space (own lyric layer) |
| `planet` | Planet | iTunes-style 3D displaced sphere with fresnel rim + starfield, audio-reactive |
| `winamp` | Winamp | butterchurn (Milkdrop) preset — driven by a synthetic AudioContext oscillator graph fed from `AudioFrame` |
| `tunnel` | Tunnel | Custom GLSL: raymarched tunnel + IQ cosine palette + beat brightness pulse |
| `minimal` | Minimal | Slate gradient + film grain + slow palette cycle on beat |
| `lensflare` | Lens flare | Pure black + animated sun core, hexagonal streaks, ghost reflections, chromatic-aberration ring (designed for `screen` blend over video) |
| `halftone` | Halftone | Black-on-cream printed-page dot pattern, dot radius modulated by bass + slow noise (designed for `multiply` blend over video) |

`auto` cycles non-MV vibes per track. Excluded: `mv` (which became a separate Video layer in v0.6).

### Lyric animations (pick one — overrides vibe's default)
File: `src/ui/lyricScene.ts` (DOM modes), `src/ui/lyric3d.ts` (spatial), `src/ui/lyricParticles.ts` (particles).

| id | what it is |
|---|---|
| `auto` | Use vibe's `lyricStyle.animation` default |
| `particles` | NEW (v0.11): Spectral field + FFT bars + 6000-particle word formation. Owns lyric layer. |
| `spatial` | 3D extruded TextGeometry + Helvetica Bold typeface, camera fly-through, springy per-word beat punch + Z-stretch on bass. Owns lyric layer. |
| `snippet` | Word-windowed (current ± `snippetWindow` words visible) |
| `karaoke` | Whole-line gold colour wipe per word (`clip-path` animation) |
| `subtitle` | Bottom translucent black scrim band, broadcast-TV style |
| `scroll` | Single line scroll-in animation |
| `fade` | Fade in / fade out |
| `typewriter` | Per-character reveal |
| `bounce` | Per-word bounce-in |

Plus a **"Hold lyrics"** boolean toggle: keeps already-sung words visible at 0.85 opacity instead of fading.

### Video layer (independent of vibe — composites on top)
File: `src/ui/videoLayer.ts`. Backed by `sidecar/mv.mjs` (yt-dlp + HTTP file serving with Range support). Local cache `sidecar/mv-cache/` keyed by youtube id.

| id | what it does |
|---|---|
| `off` | No video |
| `on` | Full opacity, normal blend (covers the vibe) |
| `screen` | `mix-blend-mode: screen` — vibe's bright bits paint into video |
| `multiply` | `mix-blend-mode: multiply` — vibe's dark bits darken video |
| `difference` | `mix-blend-mode: difference` — psychedelic invert |

Per-track sync offset (manually nudgeable with `[` / `]` ±100ms, persisted in localStorage). Auto-aligns by `videoDuration − trackDuration` on `loadedmetadata` if user hasn't nudged.

### Beat / tempo source (pipeline)
- **Ableton Link** (preferred): C++ `link_helper` via `abl_link` C wrapper joins the Djay session. Returns BPM, beat phase, peer count, playing/stopped. ~30Hz polled, locally extrapolated to `performance.now()` clock.
- **AudioFrame energy-onset**: `src/audio/capture.ts` reads BlackHole loopback via `getUserMedia`, FFT 2048 → log-banded spectrum → 1.4× rolling-mean bass onset detector with 300ms refractory. Synthetic 120 BPM fallback if `getUserMedia` fails.
- Renderers prefer Link's beat rising-edge when `link.peers > 0 && link.playing`, else fall back to audio onset.

### Audio spectrum (drives reactivity everywhere)
`AudioFrame` shape (in `src/types.ts`):
```
t, bass (0–1), mid (0–1), treble (0–1), level (0–1), beat (0–1, decays), fft? (Float32Array 512 dB)
```
Bass < 250 Hz, mid 250–2000 Hz, treble > 2000 Hz. Auto-gain via per-band rolling max (decay 0.9995/frame). RMS for level.

### Now-playing source
`sidecar/nowplaying_helper.swift` reads `MediaRemote.framework` (private SPI) via `/usr/bin/swift` interpreter (signed; the unsigned compiled binary gets gated empty results on macOS Sequoia+). Outputs JSON every poll with title/artist/album/duration/elapsed/timestamp/playbackRate/contentItemId/artwork. Sidecar dedupes by identity tuple, broadcasts `now-playing` + `playhead` events.

### Lyrics
LRCLIB free API → cached in localStorage with 30-day TTL → line-level synced timestamps. Word timing: real word-timestamps when the LRC is enhanced, otherwise interpolated linearly weighted by character count. Vite proxy at `/lrclib` injects User-Agent header (which browsers strip).

---

## 3. Architecture map

```
                ┌────────────────────────┐
                │ Djay Pro (or anything) │
                └───────┬──────────────┬─┘
                        │ MediaRemote   │ Ableton Link UDP
                        │ (system SPI)  │ (network multicast)
                        ▼               ▼
   ┌──────────────────────────────────────────────┐
   │ Node sidecar  http+ws on 127.0.0.1:7777      │
   │   ├─ /usr/bin/swift nowplaying_helper.swift  │   30 Hz poll
   │   ├─ link_helper (C++, abl_link)             │   30 Hz poll
   │   └─ /mv* HTTP routes (yt-dlp, file serving) │
   └─────────────────────┬────────────────────────┘
                         │ WebSocket events:
                         │  • now-playing  • playhead
                         │  • link         • stopped
                         ▼
   ┌──────────────────────────────────────────────┐
   │ Browser renderer (Vite + TS + three.js)      │
   │                                              │
   │   AppState  ◀──── store.ts (pubsub)          │
   │     ├─ playhead, link, nowPlaying            │
   │     ├─ lyrics                                │
   │     ├─ currentVibe, lyricAnimationOverride   │
   │     ├─ lyricsHold, lyricsVisible             │
   │     └─ autoVibe                              │
   │                                              │
   │   Stage (canvas) → Vibe.update(audio, dt)    │
   │   VideoLayer (DOM <video>, mix-blend-mode)   │
   │   LyricScene → DOM modes / Lyric3D canvas /  │
   │                LyricParticles canvas         │
   │                                              │
   │   AudioCapture → AudioFrame → all consumers  │
   └──────────────────────────────────────────────┘
```

---

## 4. The complexity problem

The control bar today is a row of dropdowns that has slowly grown to:
**Vibe · Lyrics · Video** (each with 5–10 options) **+ Lyrics on/off · Hold on/off**.

What it doesn't expose:
- Per-vibe colour palettes
- Per-vibe reactivity intensity (some songs need lower `uBeat` amplitude to not feel epileptic)
- Per-lyric-mode size/position offsets
- Layering: e.g. user wants the **spectrum bars from Particles mode** on top of **Tunnel vibe** with the **subtitle lyric layer** — not currently possible because each mode is monolithic.
- Frequency mapping: bass band cutoff, treble cutoff, "punchiness" of the onset detector, etc.
- Saved bundles ("my floor preset", "lounge preset")

User's words: *"I want to be able to set some parameters like colors, reactivity, mapping of high and lows, spread."* — and *"vibe and lyrics animation should be untangled again"* (right now `particles` and `spatial` are lyric modes that take over the lyric layer; `flythrough` is a vibe that takes over the lyric layer; the boundaries leak).

The user also wants **layering**: spectrum bars or perlin background as toggleable on/off elements that compose with anything.

---

## 5. Design direction (what to build next)

### 5.1 Decompose every visualization into independent **layers**

Every existing vibe / lyric mode breaks down into a few primitive elements that we currently bundle:

| primitive | currently lives in |
|---|---|
| Starfield / warp streaks | flythrough, planet, lyricParticles (different shaders) |
| Tron grid floor | flythrough |
| Halftone dots | halftone |
| Lens flare core + ghosts | lensflare |
| Particle word formation | lyricParticles |
| FFT bars | lyricParticles |
| Perlin noise field | lyricParticles, planet (different) |
| 3D extruded text | lyric3d |
| 3D SDF text (troika) | flythrough |
| DOM lyric line (snippet/scroll/fade/etc) | lyricScene |
| Subtitle band | lyricScene (subtitle) |
| Karaoke wipe | lyricScene (karaoke) |
| Music video element | videoLayer |
| Vibe canvas (catch-all bg shader) | every vibe |

**Refactor target:** a single composable **Layer** type:
```ts
interface Layer {
  id: string;              // "stars", "grid", "particles-text", "subtitle", ...
  name: string;
  enabled: boolean;
  params: Record<string, unknown>;  // typed via per-layer schema
  mount(host): void;
  update(positionMs, dt, audio, link): void;
  unmount(): void;
}
```
Plus a per-layer **ParamSchema** describing controls (sliders, colour pickers, enums) so the UI is generated, not hardcoded.

The **Stage** becomes a thin sequencer:
1. Maintain an ordered list of active layers.
2. Each frame, call `update` on each in order.
3. Layers may render to the shared canvas (z-ordered) OR own their own DOM overlay.
4. When a layer can't co-exist with another (e.g., two competing 3D scenes), declare an **exclusivity group**.

### 5.2 Presets — named bundles of (layers + params)

```ts
interface Preset {
  id: string;                // "demo-scene", "broadcast", "karaoke-bar", "newsprint"
  name: string;
  description?: string;
  layers: { id: string; params: Record<string, unknown> }[];
  // Optionally: lock specific layers so user can't change them (a "Halftone Newsprint" preset locks halftone + multiply video).
}
```

Ship a starter set rebuilding today's bundles:
- **"Spatial 3D"** = stars + 3D extruded text
- **"Particles + spectrum"** = perlin field + FFT bars + particle text
- **"Newsprint"** = halftone + subtitle + multiply-blend video
- **"Demo scene"** = grid + stars + flythrough text
- **"Lens flare karaoke"** = lens flare + karaoke wipe
- **"Broadcast"** = subtitle only over whatever vibe

User can save their own.

### 5.3 Parameter exposure

Per-layer schema example:
```ts
{
  id: "particle-text",
  params: [
    { id: "particleCount", type: "int", min: 500, max: 12000, default: 6000 },
    { id: "spread",        type: "float", min: 0, max: 2, default: 1, label: "Spread" },
    { id: "colorWarm",     type: "color", default: "#ffd6a8" },
    { id: "colorCool",     type: "color", default: "#b8d8ff" },
    { id: "beatKick",      type: "float", min: 0, max: 5, default: 2.0, label: "Beat punch" },
    { id: "bassReact",     type: "float", min: 0, max: 2, default: 1, label: "Bass reactivity" },
    { id: "swirl",         type: "float", min: 0, max: 2, default: 0.4 },
    { id: "trail",         type: "float", min: 0, max: 1, default: 0 },
  ],
}
```

Common parameters across the board:
- `bassReact`, `midReact`, `trebleReact`, `beatReact`, `linkSync` (bool)
- `bassCutoffHz`, `trebleCutoffHz` (re-tune the audio bands)
- `colorPrimary`, `colorAccent`, `palette` (named or custom)
- `intensity` (0–1 master)
- `position`, `scale`, `rotation` (world transforms where applicable)

A lot of these already exist as constants in shaders — refactoring them into uniforms driven by params is mechanical work, but unblocks the panel.

### 5.4 Audio routing / mapping

Today the bass/mid/treble cutoffs are hardcoded (250 Hz, 2 kHz). Expose them as shared params on an "audio routing" pseudo-layer:
- `bassMaxHz`, `midMaxHz` (upper edges)
- `attackMs`, `releaseMs` for the per-band envelopes
- `gain` per band
- `beatThreshold` (the 1.4× constant in the onset detector)
- `linkQuantum` (currently 4 — let user pick 1, 2, 4, 8)

This becomes the single source of truth that all reactive layers consume.

### 5.5 Remote-control panel — iPad first

The killer move. Architecture suggestions:

**Option A — iPad in a browser tab.** Sidecar already serves HTTP on 7777. Mount a second route, `/control`, that serves a separate small SPA (React/Preact/Solid/Svelte — pick lean). It connects to the same WebSocket and reads/writes shared state. The renderer at `:5173` and the panel at `7777/control` both subscribe to the same store; bidirectional via WS messages.

**Option B — Native iOS/iPadOS.** Way more work, ignore unless we ship.

Go with A. Concrete shape:

```
                   shared AppState
                  /      |        \
         renderer  +  panel-A  +  panel-B (multiple iPads OK)
            |         /
            └───── ws://<mac-ip>:7777
                        │
                  sidecar (broadcast model already)
```

**Sidecar protocol additions:**
- Renderer/panel can send `{kind: "param-set", layerId, paramId, value}` and `{kind: "preset-load", presetId}` and `{kind: "layer-toggle", layerId, enabled}`.
- Sidecar applies to its own state model AND broadcasts to all peers.
- Persistent preset storage in a JSON file in the sidecar (`sidecar/presets.json`).

**Panel UI shape (touch-first):**
- Tab bar at top: Layers · Params · Presets · Now Playing
- **Layers tab**: vertical list, big toggle per layer, drag-handle to reorder
- **Params tab**: when a layer is selected, render its schema as fat sliders + colour swatches (44pt min hit targets for iPad)
- **Presets tab**: grid of preset thumbnails (could be CSS gradients as placeholder until we render real previews); long-press to save current state as a new preset
- **Now Playing tab**: track info + BPM + Link peer count + manual `[` / `]` MV offset nudge buttons + audio capture status

Visual style: dark, high-contrast, tactile. Avoid hover states (no hover on touch). Consider haptic-feedback equivalents (small visual confirmations).

LAN networking note: the user must use `npm run dev -- --host` (Vite) and start the sidecar bound to `0.0.0.0:7777` instead of `127.0.0.1:7777`. Add a CLI flag or env var. Discoverability: print the LAN URL on boot so the user can type it into the iPad's Safari.

mDNS / Bonjour for zero-config? Maybe. macOS has `dns-sd` CLI. Stretch goal.

### 5.6 Untangling vibe ↔ lyrics

Once layers are real, this falls out for free:
- "Vibe" stops being a single thing. The user picks any combination of background layers.
- "Lyric mode" stops being a single thing. The user picks any combination of lyric-rendering layers.
- Spatial 3D text and Particle Word are both **text layers**, not lyric modes.
- Stars / grid / spectrum bars / perlin field are all **background layers**.
- Subtitle / karaoke / scroll / fade are all **DOM lyric overlays**.
- Today's `flythrough` vibe = stars + grid + 3D-text-spatial all bundled. That bundle survives as a **preset**, but each piece is independently toggleable.

---

## 6. What's already in place that helps

- **WebSocket broadcast model** in `sidecar/index.mjs` already replays state on new client connect. Adding inbound messages for control is a small extension.
- **AppState store** in `src/state/store.ts` is a pubsub keyed by single object — easy to widen with `layers`, `params`, `presets`.
- **Vibe interface** in `src/types.ts` is already shaped close to a Layer (has mount/update/unmount). Refactor target: rename and split, don't redesign from scratch.
- **`AudioFrame` contract** is solid and already consumed everywhere.
- **localStorage cache patterns** for offsets and lyrics translate cleanly to preset persistence (or move to sidecar JSON for cross-device sync).
- **Vite dev server** can host two pages (renderer + control panel) trivially.

---

## 7. Recommended order of operations for the next session

1. **Spec the Layer + Param schema** (don't write code yet — pin the contract).
2. **Refactor one existing vibe into the new Layer model** as the proof. Pick `halftone` — small, self-contained, has nice param targets (cell size, dot color, beat splat opacity).
3. **Add inbound `param-set` / `layer-toggle` to the sidecar protocol** + state-broadcast.
4. **Sketch the iPad panel** as a minimal Preact app at `7777/control`. Start with Layers tab (toggles only). Validate the WS round-trip end-to-end.
5. **Migrate remaining vibes + lyric modes to layers**, one at a time. Each migration unlocks more params for the panel.
6. **Presets** — JSON-on-sidecar, simple list view in the panel.
7. **Polish:** thumbnails, drag-reorder, haptic-y feedback, mDNS announce.

Don't try to do all of this in one push. Vibe-by-vibe migration is the only sane path.

---

## 8. Constraints & open choices for the user

Things to decide before deep work:

- **Panel framework.** Preact (lightest, no JSX overhead), Svelte (best touch ergonomics), or vanilla TS + Web Components (fewest deps)? Recommend **Preact + Tailwind** — small, fast, well-trodden iPad story.
- **Network exposure.** Sidecar bound to `0.0.0.0` is a security choice — anyone on the booth's wifi can mess with the visuals. Add a one-time pairing PIN? Probably overkill for v1, just bind explicitly and warn on boot.
- **Multi-panel arbitration.** If two iPads change `bassReact` simultaneously, last-write-wins is fine (visual layer). Don't overthink.
- **Param transitions.** Should slider drags ease into target values (smooth) or snap (responsive)? Default to easing 80–120ms — feels polished, doesn't sacrifice feel.
- **What does "Auto" do in the new world?** Probably becomes "Auto preset cycle per track". Cycles among presets, not individual layers.

---

## 9. File pointers (where things live)

```
src/
  main.ts                         boot, wires everything
  types.ts                        AppState, AudioFrame, Vibe, LyricStyle, LinkState
  state/store.ts                  pubsub
  sources/mediaRemoteSource.ts    WS client, anchor-rebases playhead+link
  audio/capture.ts                getUserMedia + FFT + onset
  renderer/scene.ts               Stage (canvas owner, RAF loop, vibe host)
  vibes/                          flythrough, planet, winamp, tunnel, minimal,
                                   lensflare, halftone, registry
  ui/
    lyricScene.ts                 DOM modes + spatial/particles dispatch
    lyric3d.ts                    3D extruded text renderer
    lyricParticles.ts             particle word + spectral field renderer
    videoLayer.ts                 music video DOM element + blend modes
    controlBar.ts                 the current control bar (will be split off)

sidecar/
  index.mjs                       Node WS+HTTP server, helper management
  nowplaying_helper.swift         MediaRemote SPI poller
  link_helper.cpp                 abl_link C wrapper participant
  mv.mjs                          yt-dlp + HTTP file serving with Range
```

`vendor/link/` (gitignored) holds Ableton Link's source for `link_helper`'s build.

---

## 10. One-paragraph version (TL;DR for the next Claude)

We have a working Mac DJ visualizer with 7 background "vibes", 9 lyric "modes", a music-video overlay with blend-mode compositing, audio-capture FFT/beat detection, and Ableton Link locked to Djay's tempo. The control surface has grown to 5+ dropdowns and the modes are entangled — `particles` and `spatial` lyric modes own the canvas and double as backgrounds, `flythrough` is a vibe but renders 3D lyrics. **Refactor target:** every visualization element becomes an independently toggleable Layer with a typed parameter schema; bundles of layers become saveable Presets. Build a touch-first remote-control panel (Preact + Tailwind) at `http://<mac-ip>:7777/control` so the DJ can drive everything from an iPad over WebSocket. Migrate vibe-by-vibe; start with the smallest one (`halftone`) to validate the contract before tackling the rest.
