# Ljay

Live DJ lyrics karaoke + VJ visualizer. v0.1 — Mac only, Djay Pro tested, but works with **anything that publishes to macOS Now Playing** (Serato, Rekordbox, Traktor, Music.app, Spotify, browser tabs).

See [PLAN.md](PLAN.md) and [MVP.md](MVP.md) for the design.

## Quick start

```bash
npm install
npm run dev
```

Two processes start: a Node sidecar (`localhost:7777`) that polls macOS Now Playing via a Swift helper, and the Vite renderer at `localhost:5173`.

The first run JIT-compiles `sidecar/nowplaying_helper` from `nowplaying_helper.swift`. Apple's Swift toolchain that ships with macOS is enough — no Xcode needed.

Open the renderer in Chrome, start playing music in **Djay Pro** (or any media app), and lyrics + a vibe should follow.

## Audio reactivity

The vibes need to *hear* the audio. In Chrome, allow microphone access when prompted, then pick a loopback device:

- Install **BlackHole 2ch** (free, `brew install blackhole-2ch`).
- macOS → Audio MIDI Setup → create a Multi-Output Device that includes BlackHole + your speakers.
- In Djay Pro, set master out → BlackHole (or the multi-out).
- In Chrome, the mic dropdown lets you pick "BlackHole 2ch."

If you skip this, the vibes still animate (synthetic 120 BPM beat) so dev keeps moving.

## Layout

- `sidecar/` — Swift Now Playing helper + Node WebSocket bridge.
- `src/sources/` — `TrackSource` implementations.
- `src/lyrics/` — LRCLIB resolver, LRC parser, cache, store.
- `src/audio/` — Web Audio capture + FFT bucketization.
- `src/vibes/` — Visual presets (Winamp/Tunnel/Minimal).
- `src/renderer/` — three.js stage and vibe host.
- `src/ui/` — Lyric scene + control bar.
- `src/state/` — Tiny pubsub store.
- `src/types.ts` — All shared contracts. Touch carefully.

## Hotkeys

- `L` — toggle lyrics
- `V` — cycle vibes
- `F` — fullscreen
- `H` — show/hide control bar
- `[` / `]` — nudge sync −/+ 50 ms (TODO)

## Status: scaffold

This is the day-1 spike. Many things are stubs — see `MVP.md` weeks 2+.
