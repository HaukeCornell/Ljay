interface MountOpts {
  host: HTMLElement;
  vibes: { id: string; name: string }[];
  onVibeChange(id: string): void;
  onLyricsToggle(visible: boolean): void;
}

interface ControlBarHandle {
  setNowPlaying(s: string): void;
  setStatus(s: string): void;
  setVibe(id: string): void;
  setLyricsVisible(v: boolean): void;
  setHidden(v: boolean): void;
}

const AUTO_HIDE_MS = 3000;

export function mountControlBar(opts: MountOpts): ControlBarHandle {
  const bar = opts.host;
  const picker = bar.querySelector<HTMLSelectElement>("#vibe-picker")!;
  const toggleBtn = bar.querySelector<HTMLButtonElement>("#toggle-lyrics")!;
  const nowEl = bar.querySelector<HTMLSpanElement>("#now-playing")!;
  const statusEl = bar.querySelector<HTMLSpanElement>("#status")!;

  // Populate vibe picker.
  picker.replaceChildren();
  for (const v of opts.vibes) {
    const opt = document.createElement("option");
    opt.value = v.id;
    opt.textContent = v.name;
    picker.appendChild(opt);
  }

  let lyricsVisible = true;
  let hidden = false;
  let hideTimer: number | null = null;

  const scheduleHide = () => {
    if (hideTimer !== null) window.clearTimeout(hideTimer);
    hideTimer = window.setTimeout(() => {
      bar.classList.add("hidden");
      hidden = true;
    }, AUTO_HIDE_MS);
  };
  const showBar = () => {
    if (hidden) {
      bar.classList.remove("hidden");
      hidden = false;
    }
    scheduleHide();
  };

  picker.addEventListener("change", () => {
    opts.onVibeChange(picker.value);
    showBar();
  });

  toggleBtn.addEventListener("click", () => {
    lyricsVisible = !lyricsVisible;
    updateToggleLabel();
    opts.onLyricsToggle(lyricsVisible);
    showBar();
  });

  const updateToggleLabel = () => {
    toggleBtn.textContent = `Lyrics: ${lyricsVisible ? "on" : "off"}`;
  };

  // Mouse activity → reveal.
  window.addEventListener("mousemove", showBar, { passive: true });
  window.addEventListener("mousedown", showBar, { passive: true });

  // Keyboard shortcuts.
  window.addEventListener("keydown", (e) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement) {
      return;
    }
    const k = e.key.toLowerCase();
    if (k === "l") {
      lyricsVisible = !lyricsVisible;
      updateToggleLabel();
      opts.onLyricsToggle(lyricsVisible);
      showBar();
    } else if (k === "v") {
      const ids = opts.vibes.map(v => v.id);
      if (ids.length === 0) return;
      const i = Math.max(0, ids.indexOf(picker.value));
      const nextId = ids[(i + 1) % ids.length];
      picker.value = nextId;
      opts.onVibeChange(nextId);
      showBar();
    } else if (k === "f") {
      if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen?.().catch(() => {});
      } else {
        document.exitFullscreen?.().catch(() => {});
      }
    } else if (k === "h") {
      if (hidden) showBar();
      else {
        bar.classList.add("hidden");
        hidden = true;
        if (hideTimer !== null) window.clearTimeout(hideTimer);
      }
    }
  });

  scheduleHide();
  updateToggleLabel();

  return {
    setNowPlaying(s) { nowEl.textContent = s; },
    setStatus(s) { statusEl.textContent = s; },
    setVibe(id) { if (picker.value !== id) picker.value = id; },
    setLyricsVisible(v) {
      lyricsVisible = v;
      updateToggleLabel();
    },
    setHidden(v) {
      hidden = v;
      bar.classList.toggle("hidden", v);
      if (!v) scheduleHide();
    },
  };
}
