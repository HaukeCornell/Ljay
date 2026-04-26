// Ljay control panel — Preact port of the design's panel.jsx.
//
// Visual layout, animation, and interactions match the design pixel-for-pixel.
// State, however, is sourced from the sidecar WebSocket (see ./state.ts) — the
// design's local-only `useVjay` is replaced. The contracts for control paths
// match the `control-set` plane the renderer also subscribes to.

import { useMemo, useRef, useState } from "preact/hooks";
import type { JSX } from "preact";
import { C } from "./colors";
import { EFFECTS, LYRIC_STYLES } from "./catalog";
import { PreviewCanvas } from "./PreviewCanvas";
import {
  Renderers,
  fallbackRenderer,
  type RendererParams,
} from "./renderers";
import { resetControlState, setControlPath, useControlState } from "./state";

type CSSObj = JSX.CSSProperties;

// ─── Preview card with tap-toggle, vertical swipe for opacity ────────────────

interface EffectCardProps {
  id: string;
  name: string;
  params: RendererParams;
  enabled: boolean;
  opacity: number;
  onToggle: () => void;
  onOpacity: (op: number) => void;
  onCustomize: () => void;
  isLyric?: boolean;
  lyricActive?: boolean;
  /** Visually dim cards that don't drive a real renderer yet. */
  previewOnly?: boolean;
}

function EffectCard({
  id,
  name,
  params,
  enabled,
  opacity,
  onToggle,
  onOpacity,
  onCustomize,
  isLyric = false,
  lyricActive = false,
  previewOnly = false,
}: EffectCardProps) {
  const [dragging, setDragging] = useState(false);
  const [hint, setHint] = useState(0); // 0 idle, 1 opacity hint visible

  const renderer = useMemo(() => {
    const key = isLyric ? `lyric_${id}` : id;
    const fn = Renderers[key];
    return fn ? fn(params) : fallbackRenderer();
    // Re-derive only when params change. Render each frame uses the closure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, params.color, params.accent, params.reactivity, isLyric]);

  const onPointerDown = (
    e: JSX.TargetedMouseEvent<HTMLDivElement> | JSX.TargetedTouchEvent<HTMLDivElement>,
  ): void => {
    e.preventDefault();
    const me = e as unknown as MouseEvent;
    const te = e as unknown as TouchEvent;
    const startY = me.clientY ?? te.touches?.[0]?.clientY ?? 0;
    const startX = me.clientX ?? te.touches?.[0]?.clientX ?? 0;
    const startOp = opacity;
    let moved = false;
    let isVerticalDrag = false;
    const move = (ev: MouseEvent | TouchEvent): void => {
      const mev = ev as MouseEvent;
      const tev = ev as TouchEvent;
      const y = mev.clientY ?? tev.touches?.[0]?.clientY ?? startY;
      const x = mev.clientX ?? tev.touches?.[0]?.clientX ?? startX;
      const dy = startY - y;
      const dx = x - startX;
      if (!moved && (Math.abs(dy) > 6 || Math.abs(dx) > 6)) {
        moved = true;
        isVerticalDrag = Math.abs(dy) > Math.abs(dx);
        if (isVerticalDrag) {
          setDragging(true);
          setHint(1);
        }
      }
      if (isVerticalDrag) {
        const newOp = Math.min(1, Math.max(0, startOp + dy / 200));
        onOpacity(newOp);
      }
    };
    const up = (): void => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      window.removeEventListener("touchmove", move);
      window.removeEventListener("touchend", up);
      setDragging(false);
      setTimeout(() => setHint(0), 600);
      if (!moved) onToggle();
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    window.addEventListener("touchmove", move, { passive: false });
    window.addEventListener("touchend", up);
  };

  const isOn = isLyric ? lyricActive : enabled;
  const showOpacity = !isLyric && enabled;

  const wrapStyle: CSSObj = {
    position: "relative",
    width: "100%",
    borderRadius: 10,
    overflow: "hidden",
    background: C.bg2,
    border: `1.5px solid ${isOn ? C.accent : C.line}`,
    boxShadow: isOn
      ? `0 0 0 1px ${C.accent}30, 0 4px 18px ${C.accent}10`
      : "0 2px 8px rgba(0,0,0,0.3)",
    transition: "border-color 140ms, box-shadow 140ms",
    cursor: "pointer",
    opacity: previewOnly ? 0.45 : !isLyric && !enabled ? 0.55 : 1,
  };

  return (
    <div style={wrapStyle}>
      {/* Preview canvas — fixed height region */}
      <div
        onMouseDown={onPointerDown}
        onTouchStart={onPointerDown}
        className="no-select"
        style={{
          position: "relative",
          aspectRatio: "16 / 11",
          background: "#000",
          touchAction: "none",
        }}
      >
        <PreviewCanvas render={renderer} width={320} height={200} />

        {/* dim overlay when off */}
        {!isOn && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              background: "rgba(0,0,0,0.55)",
              pointerEvents: "none",
            }}
          />
        )}

        {/* Opacity vertical bar (only for effects, when enabled) */}
        {showOpacity && (
          <div
            style={{
              position: "absolute",
              right: 8,
              top: 8,
              bottom: 8,
              width: 4,
              borderRadius: 4,
              background: "rgba(255,255,255,0.12)",
              overflow: "hidden",
              opacity: hint || dragging ? 1 : 0.6,
              transition: "opacity 200ms",
            }}
          >
            <div
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                bottom: 0,
                height: `${opacity * 100}%`,
                background: C.accent,
                boxShadow: `0 0 8px ${C.accent}80`,
              }}
            />
          </div>
        )}

        {/* On indicator dot */}
        <div
          style={{
            position: "absolute",
            top: 10,
            left: 10,
            width: 10,
            height: 10,
            borderRadius: 10,
            background: isOn ? C.accent : "rgba(255,255,255,0.18)",
            boxShadow: isOn ? `0 0 8px ${C.accent}` : "none",
          }}
        />

        {/* Customize chip */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            onCustomize();
          }}
          style={{
            position: "absolute",
            top: 8,
            right: showOpacity ? 22 : 8,
            padding: "4px 8px",
            fontFamily: "JetBrains Mono",
            fontSize: 10,
            background: "rgba(0,0,0,0.6)",
            backdropFilter: "blur(6px)",
            border: "1px solid rgba(255,255,255,0.14)",
            color: "#fff",
            borderRadius: 6,
            letterSpacing: 0.5,
            textTransform: "uppercase",
          }}
        >
          ⋯
        </button>

        {/* Swipe hint */}
        {hint === 1 && showOpacity && (
          <div
            style={{
              position: "absolute",
              bottom: 8,
              left: 8,
              right: 26,
              fontFamily: "JetBrains Mono",
              fontSize: 10,
              color: C.accent,
              letterSpacing: 0.5,
            }}
          >
            {Math.round(opacity * 100)}%
          </div>
        )}
      </div>

      {/* Footer */}
      <div
        style={{
          padding: "8px 10px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          borderTop: `1px solid ${C.lineSoft}`,
        }}
      >
        <div
          style={{
            fontSize: 12,
            fontWeight: 500,
            color: C.text,
            letterSpacing: 0.2,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {name}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <div
            style={{
              width: 12,
              height: 12,
              borderRadius: 12,
              background: params.color,
              border: "1px solid rgba(255,255,255,0.15)",
            }}
          />
          {!isLyric && enabled && (
            <div
              style={{
                fontFamily: "JetBrains Mono",
                fontSize: 10,
                color: C.textDim,
                minWidth: 28,
                textAlign: "right",
              }}
            >
              {Math.round(opacity * 100)}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Customize popup ─────────────────────────────────────────────────────────

interface CustomizePopupProps {
  open: boolean;
  title: string;
  params: RendererParams;
  onParam: (key: string, value: unknown) => void;
  onClose: () => void;
  isLyric?: boolean;
}

function CustomizePopup({
  open,
  title,
  params,
  onParam,
  onClose,
}: CustomizePopupProps) {
  if (!open) return null;
  const swatches = [
    "#7cffb2",
    "#5b8cff",
    "#ff5ea8",
    "#ffd84a",
    "#ff5b5b",
    "#ff9344",
    "#b8d8ff",
    "#ffd6a8",
    "#ffffff",
    "#000000",
    "#f3ead4",
    "#1f2030",
  ];
  return (
    <div
      onClick={onClose}
      style={{
        position: "absolute",
        inset: 0,
        background: "rgba(0,0,0,0.65)",
        backdropFilter: "blur(8px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 100,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 460,
          background: C.bg2,
          border: `1px solid ${C.line}`,
          borderRadius: 18,
          padding: 24,
          boxShadow: "0 20px 80px rgba(0,0,0,0.6)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            justifyContent: "space-between",
            marginBottom: 18,
          }}
        >
          <div>
            <div
              style={{
                fontFamily: "JetBrains Mono",
                fontSize: 10,
                color: C.accent,
                letterSpacing: 1.5,
                textTransform: "uppercase",
              }}
            >
              Customize
            </div>
            <div
              style={{
                fontSize: 22,
                fontWeight: 600,
                color: C.text,
                marginTop: 2,
              }}
            >
              {title}
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              width: 32,
              height: 32,
              borderRadius: 16,
              background: C.bg3,
              color: C.textDim,
              border: `1px solid ${C.line}`,
              fontSize: 16,
            }}
          >
            ×
          </button>
        </div>

        <div style={{ marginBottom: 18 }}>
          <div
            style={{
              fontSize: 12,
              color: C.textDim,
              marginBottom: 8,
              letterSpacing: 0.3,
            }}
          >
            Primary color
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {swatches.map((c) => (
              <button
                key={c}
                onClick={() => onParam("color", c)}
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: 16,
                  background: c,
                  border:
                    params.color === c
                      ? `2px solid ${C.accent}`
                      : `1px solid ${C.line}`,
                  boxShadow:
                    params.color === c ? `0 0 8px ${C.accent}80` : "none",
                }}
              />
            ))}
            <input
              type="color"
              value={params.color}
              onChange={(e) =>
                onParam("color", (e.target as HTMLInputElement).value)
              }
              style={{
                width: 32,
                height: 32,
                borderRadius: 16,
                border: `1px solid ${C.line}`,
                background: "transparent",
                cursor: "pointer",
              }}
            />
          </div>
        </div>

        <div style={{ marginBottom: 18 }}>
          <div
            style={{
              fontSize: 12,
              color: C.textDim,
              marginBottom: 8,
              letterSpacing: 0.3,
            }}
          >
            Accent color
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {swatches.map((c) => (
              <button
                key={c}
                onClick={() => onParam("accent", c)}
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: 16,
                  background: c,
                  border:
                    params.accent === c
                      ? `2px solid ${C.accent}`
                      : `1px solid ${C.line}`,
                  boxShadow:
                    params.accent === c ? `0 0 8px ${C.accent}80` : "none",
                }}
              />
            ))}
            <input
              type="color"
              value={params.accent}
              onChange={(e) =>
                onParam("accent", (e.target as HTMLInputElement).value)
              }
              style={{
                width: 32,
                height: 32,
                borderRadius: 16,
                border: `1px solid ${C.line}`,
                background: "transparent",
                cursor: "pointer",
              }}
            />
          </div>
        </div>

        <FatSlider
          label="Reactivity"
          value={params.reactivity}
          onChange={(v) => onParam("reactivity", v)}
          min={0}
          max={2}
          suffix="x"
        />

        <div
          style={{
            marginTop: 24,
            display: "flex",
            justifyContent: "flex-end",
          }}
        >
          <button
            onClick={onClose}
            style={{
              padding: "10px 20px",
              borderRadius: 10,
              background: C.accent,
              color: "#0a0a0c",
              fontWeight: 600,
              fontSize: 14,
              border: "none",
            }}
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Fat slider ──────────────────────────────────────────────────────────────

interface FatSliderProps {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  suffix?: string;
}

function FatSlider({
  label,
  value,
  onChange,
  min = 0,
  max = 1,
  suffix = "",
}: FatSliderProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const pct = (value - min) / (max - min);
  const startDrag = (
    e: JSX.TargetedMouseEvent<HTMLDivElement> | JSX.TargetedTouchEvent<HTMLDivElement>,
  ): void => {
    e.preventDefault();
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return;
    const update = (clientX: number): void => {
      const t = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      onChange(min + t * (max - min));
    };
    const me = e as unknown as MouseEvent;
    const te = e as unknown as TouchEvent;
    update(me.clientX ?? te.touches?.[0]?.clientX ?? 0);
    const move = (ev: MouseEvent | TouchEvent): void => {
      const mev = ev as MouseEvent;
      const tev = ev as TouchEvent;
      update(mev.clientX ?? tev.touches?.[0]?.clientX ?? 0);
    };
    const up = (): void => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      window.removeEventListener("touchmove", move);
      window.removeEventListener("touchend", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    window.addEventListener("touchmove", move, { passive: false });
    window.addEventListener("touchend", up);
  };
  return (
    <div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          marginBottom: 8,
        }}
      >
        <div style={{ fontSize: 12, color: C.textDim, letterSpacing: 0.3 }}>
          {label}
        </div>
        <div
          style={{ fontFamily: "JetBrains Mono", fontSize: 13, color: C.text }}
        >
          {value.toFixed(2)}
          {suffix}
        </div>
      </div>
      <div
        ref={ref}
        onMouseDown={startDrag}
        onTouchStart={startDrag}
        className="no-select"
        style={{
          position: "relative",
          height: 36,
          background: C.bg,
          border: `1px solid ${C.line}`,
          borderRadius: 18,
          cursor: "ew-resize",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            bottom: 0,
            width: `${pct * 100}%`,
            background: `linear-gradient(90deg, ${C.accent}40, ${C.accent}80)`,
          }}
        />
        <div
          style={{
            position: "absolute",
            left: `calc(${pct * 100}% - 14px)`,
            top: 4,
            bottom: 4,
            width: 28,
            background: "#fff",
            borderRadius: 14,
            boxShadow: "0 2px 6px rgba(0,0,0,0.4)",
          }}
        />
      </div>
    </div>
  );
}

// ─── Now-playing header ──────────────────────────────────────────────────────

interface HeaderProps {
  title: string;
  artist: string;
  artworkDataUrl?: string;
  bpm: number | null;
  beatPulse: number;
  elapsedSec: number;
  durationSec: number;
  onReset: () => void;
}

function Header({
  title,
  artist,
  artworkDataUrl,
  bpm,
  beatPulse,
  elapsedSec,
  durationSec,
  onReset,
}: HeaderProps) {
  const fmt = (s: number): string => {
    const sec = Math.max(0, Math.floor(s));
    return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
  };
  // Hue derived from title/artist for the fallback artwork swatch.
  const hue = useMemo(() => {
    const seed = `${title}|${artist}`;
    let h = 0;
    for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
    return ((h % 360) + 360) % 360;
  }, [title, artist]);
  const swatchBg = artworkDataUrl
    ? `url(${artworkDataUrl}) center/cover`
    : `linear-gradient(135deg, hsl(${hue} 70% 50%), hsl(${hue + 60} 70% 30%))`;
  return (
    <div
      style={{
        padding: "14px 28px",
        display: "flex",
        alignItems: "center",
        gap: 16,
        borderBottom: `1px solid ${C.lineSoft}`,
      }}
    >
      <div
        style={{
          width: 44,
          height: 44,
          borderRadius: 8,
          background: swatchBg,
          boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
        }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 17,
            fontWeight: 600,
            color: C.text,
            letterSpacing: 0.2,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {title || "—"}
        </div>
        <div
          style={{
            fontSize: 13,
            color: C.textDim,
            marginTop: 1,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {artist || ""}
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
        {bpm !== null && (
          <div style={{ textAlign: "right" }}>
            <div
              style={{
                fontFamily: "JetBrains Mono",
                fontSize: 10,
                color: C.textMute,
                letterSpacing: 1.5,
              }}
            >
              BPM
            </div>
            <div
              style={{
                fontFamily: "JetBrains Mono",
                fontSize: 18,
                color: C.text,
                fontWeight: 600,
              }}
            >
              {Math.round(bpm)}
            </div>
          </div>
        )}
        <div
          style={{
            width: 12,
            height: 12,
            borderRadius: 12,
            background: C.accent,
            opacity: 0.3 + beatPulse * 0.7,
            boxShadow: `0 0 ${4 + beatPulse * 10}px ${C.accent}`,
          }}
        />
        <div style={{ textAlign: "right" }}>
          <div
            style={{
              fontFamily: "JetBrains Mono",
              fontSize: 10,
              color: C.textMute,
              letterSpacing: 1.5,
            }}
          >
            TIME
          </div>
          <div
            style={{
              fontFamily: "JetBrains Mono",
              fontSize: 14,
              color: C.text,
            }}
          >
            {fmt(elapsedSec)}{" "}
            <span style={{ color: C.textMute }}>/ {fmt(durationSec)}</span>
          </div>
        </div>
        <button
          onClick={() => {
            if (confirm("Reset all panel customization to defaults?")) onReset();
          }}
          title="Clear all colors / reactivity / offsets / selections"
          style={{
            padding: "6px 10px",
            fontFamily: "JetBrains Mono",
            fontSize: 10,
            background: C.bg3,
            border: `1px solid ${C.line}`,
            color: C.textDim,
            borderRadius: 6,
            letterSpacing: 1,
            textTransform: "uppercase",
          }}
        >
          ▽ Reset
        </button>
      </div>
    </div>
  );
}

// ─── Section title ───────────────────────────────────────────────────────────

interface SectionTitleProps {
  children: preact.ComponentChildren;
  hint?: string;
}

function SectionTitle({ children, hint }: SectionTitleProps) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "baseline",
        justifyContent: "space-between",
        padding: "0 28px",
        marginBottom: 12,
      }}
    >
      <div
        style={{
          fontSize: 16,
          fontWeight: 600,
          color: C.text,
          letterSpacing: 0.2,
          whiteSpace: "nowrap",
        }}
      >
        {children}
      </div>
      {hint && (
        <div
          style={{
            fontFamily: "JetBrains Mono",
            fontSize: 11,
            color: C.textMute,
            letterSpacing: 0.5,
          }}
        >
          {hint}
        </div>
      )}
    </div>
  );
}

// ─── Sync slider (lyrics + video) ────────────────────────────────────────────

interface SyncSliderProps {
  label: string;
  value: number;
  auto: number;
  color: string;
  onNudge: (d: number) => void;
  onReset: () => void;
}

function SyncSlider({
  label,
  value,
  auto,
  color,
  onNudge,
  onReset,
}: SyncSliderProps) {
  const min = -2000;
  const max = 2000;
  const pct = (value - min) / (max - min);
  const autoPct = (auto - min) / (max - min);
  const fmt = (ms: number): string => `${ms >= 0 ? "+" : ""}${ms} ms`;
  return (
    <div style={{ flex: 1 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          marginBottom: 8,
        }}
      >
        <div
          style={{
            fontSize: 13,
            color: C.textDim,
            letterSpacing: 0.3,
            textTransform: "uppercase",
          }}
        >
          {label} sync
        </div>
        <div
          style={{
            display: "flex",
            gap: 10,
            fontFamily: "JetBrains Mono",
            fontSize: 11,
          }}
        >
          <span style={{ color: C.textMute }}>auto ▽ {fmt(auto)}</span>
          <span
            style={{
              color: value === auto ? C.text : color,
              fontWeight: 600,
            }}
          >
            {fmt(value)}
          </span>
        </div>
      </div>
      <div
        style={{
          position: "relative",
          height: 28,
          background: C.bg,
          border: `1px solid ${C.line}`,
          borderRadius: 8,
        }}
      >
        <div
          style={{
            position: "absolute",
            left: "50%",
            top: 0,
            bottom: 0,
            width: 1,
            background: C.lineSoft,
          }}
        />
        <div
          style={{
            position: "absolute",
            left: `calc(${autoPct * 100}% - 4px)`,
            top: -8,
            fontFamily: "JetBrains Mono",
            fontSize: 10,
            color: C.textDim,
          }}
        >
          ▽
        </div>
        <div
          style={{
            position: "absolute",
            left: `${autoPct * 100}%`,
            top: 0,
            bottom: 0,
            width: 1,
            background: C.textMute,
          }}
        />
        <div
          style={{
            position: "absolute",
            left: `calc(${pct * 100}% - 3px)`,
            top: 2,
            bottom: 2,
            width: 6,
            background: color,
            borderRadius: 3,
            boxShadow: `0 0 8px ${color}`,
          }}
        />
      </div>
      <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
        {[-100, -10, +10, +100].map((d) => (
          <button
            key={d}
            onClick={() => onNudge(d)}
            style={{
              flex: 1,
              padding: "8px",
              fontFamily: "JetBrains Mono",
              fontSize: 12,
              background: C.bg3,
              border: `1px solid ${C.line}`,
              color: C.text,
              borderRadius: 6,
            }}
          >
            {d > 0 ? "+" : ""}
            {d}
          </button>
        ))}
        <button
          onClick={onReset}
          style={{
            padding: "8px 12px",
            fontFamily: "JetBrains Mono",
            fontSize: 11,
            background: C.bg3,
            border: `1px solid ${C.line}`,
            color: C.textDim,
            borderRadius: 6,
          }}
        >
          ▽ Reset
        </button>
      </div>
    </div>
  );
}

// ─── Distinct Video card ─────────────────────────────────────────────────────

interface VideoCardProps {
  videoMode: string;
  onMode: (mode: string) => void;
}

function VideoCard({ videoMode, onMode }: VideoCardProps) {
  const renderer = useMemo(() => Renderers.video({ color: "#fff", accent: "#000", reactivity: 1 }), []);
  // Wire-protocol modes vs the design's `blendMode` strings.
  // Design used: ['screen', 'multiply', 'difference', 'normal'].
  // Our contract maps "normal" -> "on" and the rest as-is. "off" is the toggle.
  const designBlends = ["screen", "multiply", "difference", "normal"] as const;
  const modeToDesign = (m: string): string => (m === "on" ? "normal" : m);
  const designToMode = (b: string): string => (b === "normal" ? "on" : b);
  const enabled = videoMode !== "off";
  const currentBlend = enabled ? modeToDesign(videoMode) : "screen";
  const opacity = 1; // panel doesn't yet expose video opacity over WS.
  return (
    <div
      style={{
        width: "100%",
        borderRadius: 14,
        overflow: "hidden",
        background: C.bg2,
        border: `1.5px solid ${enabled ? C.pink : C.line}`,
        boxShadow: enabled
          ? `0 0 0 1px ${C.pink}30, 0 4px 18px ${C.pink}10`
          : "0 2px 8px rgba(0,0,0,0.3)",
        opacity: enabled ? 1 : 0.65,
        position: "relative",
      }}
    >
      <div
        onClick={() => onMode(enabled ? "off" : "on")}
        style={{
          position: "relative",
          aspectRatio: "16 / 10",
          background: "#000",
          cursor: "pointer",
        }}
      >
        <PreviewCanvas render={renderer} width={320} height={200} />
        {!enabled && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              background: "rgba(0,0,0,0.55)",
            }}
          />
        )}
        <div
          style={{
            position: "absolute",
            top: 10,
            left: 10,
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          <div
            style={{
              width: 10,
              height: 10,
              borderRadius: 10,
              background: enabled ? C.pink : "rgba(255,255,255,0.18)",
              boxShadow: enabled ? `0 0 8px ${C.pink}` : "none",
            }}
          />
          <div
            style={{
              fontFamily: "JetBrains Mono",
              fontSize: 9,
              letterSpacing: 1.5,
              color: C.pink,
              textTransform: "uppercase",
            }}
          >
            ▶ Music video
          </div>
        </div>
      </div>
      <div style={{ padding: "10px 12px", borderTop: `1px solid ${C.lineSoft}` }}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 8,
          }}
        >
          <div style={{ fontSize: 14, fontWeight: 500, color: C.text }}>Video</div>
          <div
            style={{
              fontFamily: "JetBrains Mono",
              fontSize: 10,
              color: C.textMute,
            }}
          >
            yt · {Math.round(opacity * 100)}%
          </div>
        </div>
        {enabled && (
          <div style={{ display: "flex", gap: 4 }}>
            {designBlends.map((b) => (
              <button
                key={b}
                onClick={() => onMode(designToMode(b))}
                style={{
                  flex: 1,
                  padding: "4px 0",
                  fontFamily: "JetBrains Mono",
                  fontSize: 9,
                  background: currentBlend === b ? `${C.pink}25` : C.bg3,
                  border: `1px solid ${currentBlend === b ? C.pink : C.line}`,
                  color: currentBlend === b ? C.pink : C.textDim,
                  borderRadius: 4,
                  letterSpacing: 0.3,
                  textTransform: "uppercase",
                }}
              >
                {b.slice(0, 4)}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Main panel ─────────────────────────────────────────────────────────────

interface PopupTarget {
  id: string;
  isLyric: boolean;
}

export function Panel(): JSX.Element {
  const v = useControlState();
  const [popup, setPopup] = useState<PopupTarget | null>(null);

  const openCustomize = (id: string, isLyric: boolean): void =>
    setPopup({ id, isLyric });

  const popupParams: RendererParams | null = popup
    ? popup.isLyric
      ? v.lyricParams(popup.id)
      : v.effectParams(popup.id)
    : null;
  const popupTitle = popup
    ? popup.isLyric
      ? LYRIC_STYLES.find((l) => l.id === popup.id)?.name ?? popup.id
      : EFFECTS.find((e) => e.id === popup.id)?.name ?? popup.id
    : "";

  const popupSetParam = (key: string, val: unknown): void => {
    if (!popup) return;
    const root = popup.isLyric ? "lyricParams" : "effectParams";
    setControlPath(`${root}.${popup.id}.${key}`, val);
  };

  // Effects
  const setEffectOpacity = (id: string, op: number): void => {
    setControlPath(`effectParams.${id}.opacity`, Math.max(0, Math.min(1, op)));
  };
  const toggleEffect = (id: string, ljayVibeId: string | null): void => {
    if (!ljayVibeId) {
      // Preview-only — keep design intact but no real vibe to switch to.
      return;
    }
    setControlPath("currentVibe", ljayVibeId);
  };

  // Lyrics
  const setLyricStyle = (id: string): void => {
    setControlPath("lyricAnimation", id);
    if (!v.lyricsVisible) setControlPath("lyricsVisible", true);
  };
  const toggleLyricEnabled = (): void => {
    setControlPath("lyricsVisible", !v.lyricsVisible);
  };

  // Sync nudges
  const nudgeLyrics = (d: number): void => {
    setControlPath("lyricsOffsetMs", v.lyricsOffsetMs + d);
  };
  const resetLyrics = (): void => {
    setControlPath("lyricsOffsetMs", 0);
  };
  const nudgeVideo = (d: number): void => {
    if (!v.videoTrackKey) return;
    setControlPath(
      `videoOffsetMs.${v.videoTrackKey}`,
      v.videoOffsetMs + d,
    );
  };
  const resetVideo = (): void => {
    if (!v.videoTrackKey) return;
    setControlPath(`videoOffsetMs.${v.videoTrackKey}`, 0);
  };

  return (
    <div
      style={{
        width: "100vw",
        height: "100vh",
        background: C.bg,
        color: C.text,
        fontFamily: "Inter Tight, sans-serif",
        display: "flex",
        flexDirection: "column",
        position: "relative",
        overflow: "hidden",
      }}
    >
      <Header
        title={v.nowPlaying?.title ?? ""}
        artist={v.nowPlaying?.artist ?? ""}
        artworkDataUrl={v.nowPlaying?.artworkDataUrl}
        bpm={v.bpm}
        beatPulse={v.beatPulse}
        elapsedSec={v.elapsedSec}
        durationSec={v.durationSec}
        onReset={resetControlState}
      />

      <div
        style={{
          flex: 1,
          overflowY: "auto",
          overflowX: "hidden",
          padding: "14px 0 8px",
        }}
        className="panel-scroll"
      >
        {/* Effects */}
        <SectionTitle hint="tap toggle · drag up/down opacity · ⋯ customize">
          Visual effects
        </SectionTitle>
        <div
          style={{
            padding: "0 28px",
            display: "grid",
            gridTemplateColumns: "repeat(5, 1fr)",
            gap: 12,
            marginBottom: 18,
          }}
        >
          {EFFECTS.map((e) => {
            const params = v.effectParams(e.id);
            const enabled =
              e.ljayVibeId !== null && v.currentVibe === e.ljayVibeId;
            const opacity = params.opacity ?? 1;
            return (
              <EffectCard
                key={e.id}
                id={e.id}
                name={e.name}
                params={params as RendererParams}
                enabled={enabled}
                opacity={opacity}
                previewOnly={e.ljayVibeId === null}
                onToggle={() => toggleEffect(e.id, e.ljayVibeId)}
                onOpacity={(op) => setEffectOpacity(e.id, op)}
                onCustomize={() => openCustomize(e.id, false)}
              />
            );
          })}

          {/* Video card — distinct, slotted at end of effects grid */}
          <VideoCard
            videoMode={v.videoMode}
            onMode={(mode) => setControlPath("videoMode", mode)}
          />
        </div>

        {/* Lyrics — horizontal scroll */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "0 28px",
            marginBottom: 14,
          }}
        >
          <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
            <div
              style={{
                fontSize: 16,
                fontWeight: 600,
                color: C.text,
                letterSpacing: 0.2,
                whiteSpace: "nowrap",
              }}
            >
              Lyric style
            </div>
            <button
              onClick={toggleLyricEnabled}
              style={{
                padding: "4px 12px",
                borderRadius: 999,
                background: v.lyricsVisible ? `${C.accent}20` : C.bg3,
                border: `1px solid ${v.lyricsVisible ? C.accent : C.line}`,
                color: v.lyricsVisible ? C.accent : C.textDim,
                fontFamily: "JetBrains Mono",
                fontSize: 10,
                letterSpacing: 1,
                textTransform: "uppercase",
              }}
            >
              {v.lyricsVisible ? "On" : "Off"}
            </button>
          </div>
          <div
            style={{
              fontFamily: "JetBrains Mono",
              fontSize: 11,
              color: C.textMute,
              letterSpacing: 0.5,
            }}
          >
            tap to pick · ⋯ customize
          </div>
        </div>
        <div
          className="panel-scroll"
          style={{
            overflowX: "auto",
            overflowY: "hidden",
            padding: "0 28px 4px",
            scrollSnapType: "x proximity",
          }}
        >
          <div
            style={{
              display: "flex",
              gap: 14,
              paddingBottom: 6,
              opacity: v.lyricsVisible ? 1 : 0.5,
            }}
          >
            {LYRIC_STYLES.map((l) => {
              const params = v.lyricParams(l.id);
              const active =
                v.lyricAnimation === l.id && v.lyricsVisible;
              return (
                <div
                  key={l.id}
                  style={{
                    width: 180,
                    flexShrink: 0,
                    scrollSnapAlign: "start",
                  }}
                >
                  <EffectCard
                    id={l.id}
                    name={l.name}
                    params={params as RendererParams}
                    enabled={active}
                    opacity={1}
                    isLyric
                    lyricActive={active}
                    onToggle={() => setLyricStyle(l.id)}
                    onOpacity={() => {
                      /* lyrics have no per-card opacity */
                    }}
                    onCustomize={() => openCustomize(l.id, true)}
                  />
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Sync footer */}
      <div
        style={{
          padding: "16px 28px 18px",
          borderTop: `1px solid ${C.lineSoft}`,
          background: C.bg2,
          display: "flex",
          gap: 24,
        }}
      >
        <SyncSlider
          label="Lyrics"
          value={v.lyricsOffsetMs}
          auto={0}
          color={C.yellow}
          onNudge={nudgeLyrics}
          onReset={resetLyrics}
        />
        <SyncSlider
          label="Video"
          value={v.videoOffsetMs}
          auto={0}
          color={C.pink}
          onNudge={nudgeVideo}
          onReset={resetVideo}
        />
      </div>

      <CustomizePopup
        open={!!popup}
        title={popupTitle}
        params={popupParams ?? { color: "#000", accent: "#000", reactivity: 0 }}
        onParam={popupSetParam}
        onClose={() => setPopup(null)}
        isLyric={popup?.isLyric}
      />
    </div>
  );
}
