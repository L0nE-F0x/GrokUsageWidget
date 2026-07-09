import { invoke as tauriInvoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";

// -- Types ------------------------------------------------------------------

interface CategoryUsage {
  id: string;
  name: string;
  used: number;
  limit: number;
  percent: number;
  unit?: string | null;
}

interface UsageSnapshot {
  overallPercent: number;
  categories: CategoryUsage[];
  resetsDate?: string;
  resetsTime?: string;
  resetsDisplay?: string;
  extraCredits?: number | null;
  extraCreditsLabel?: string | null;
  fetchedAt: string;
  source?: string | null;
  note?: string | null;
}

interface UsageResponse {
  ok: boolean;
  data?: UsageSnapshot | null;
  error?: string | null;
}

interface AppSettings {
  refreshIntervalMinutes: number;
  alwaysOnTop: boolean;
  browserUserDataDir?: string | null;
  browserChannel?: string | null;
  headedForLogin: boolean;
  alwaysHeaded: boolean;
  /** True after a successful live SuperGrok fetch */
  setupComplete?: boolean;
  windowX?: number | null;
  windowY?: number | null;
  /** Compact sleek pill window */
  compactMode?: boolean;
}

const IN_TAURI = isTauri();

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!IN_TAURI) {
    throw new Error(
      "Open the Grok Usage desktop app (not a browser tab) to load real data."
    );
  }
  return tauriInvoke<T>(cmd, args);
}

// -- DOM --------------------------------------------------------------------

const $ = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T | null;

const els = {
  app: $("app"),
  setup: $("state-setup"),
  loading: $("state-loading"),
  error: $("state-error"),
  content: $("state-content"),
  settings: $("settings-panel"),
  sleekBar: $("sleek-bar"),
  sleekPercent: $("sleek-percent"),
  sleekFill: $("sleek-fill"),
  sleekLabel: $("sleek-label"),
  errorMsg: $("error-message"),
  loadingTitle: $("loading-title"),
  loadingHint: $("loading-hint"),
  overallLabel: $("overall-label"),
  overallPct: $("overall-percent"),
  overallFill: $("overall-fill"),
  categoryList: $("category-list"),
  resetsDate: $("resets-date"),
  resetsTime: $("resets-time"),
  creditsBlock: $("credits-block"),
  creditsValue: $("credits-value"),
  lastUpdated: $("last-updated"),
  dataNote: $("data-note"),
  btnRefresh: $("btn-refresh") as HTMLButtonElement | null,
  btnRetry: $("btn-retry") as HTMLButtonElement | null,
  btnErrorSetup: $("btn-error-setup") as HTMLButtonElement | null,
  btnOpenUsage: $("btn-open-usage") as HTMLButtonElement | null,
  btnPin: $("btn-pin") as HTMLButtonElement | null,
  btnCompact: $("btn-compact") as HTMLButtonElement | null,
  btnSleekExpand: $("btn-sleek-expand") as HTMLButtonElement | null,
  btnSettings: $("btn-settings") as HTMLButtonElement | null,
  btnMinimize: $("btn-minimize") as HTMLButtonElement | null,
  btnSettingsSave: $("btn-settings-save") as HTMLButtonElement | null,
  btnSettingsCancel: $("btn-settings-cancel") as HTMLButtonElement | null,
  btnConnect: $("btn-connect") as HTMLButtonElement | null,
  setRefresh: $("set-refresh") as HTMLInputElement | null,
  setAot: $("set-aot") as HTMLInputElement | null,
  setHeaded: $("set-headed") as HTMLInputElement | null,
  setAlwaysHeaded: $("set-always-headed") as HTMLInputElement | null,
  setChannel: $("set-channel") as HTMLSelectElement | null,
  setProfile: $("set-profile") as HTMLInputElement | null,
  defaultProfileHint: $("default-profile-hint"),
};

// -- State ------------------------------------------------------------------

let settings: AppSettings = {
  refreshIntervalMinutes: 5,
  alwaysOnTop: true,
  headedForLogin: true,
  alwaysHeaded: false,
  setupComplete: false,
  compactMode: false,
};
let lastFetchedAt: Date | null = null;
let lastWasLive = false;
let lastOverallPercent: number | null = null;
let refreshTimer: ReturnType<typeof setInterval> | null = null;
let loading = false;

// -- UI helpers -------------------------------------------------------------

type Panel = "setup" | "loading" | "error" | "content" | "settings";

function showPanel(which: Panel) {
  // In compact mode only content (via sleek bar) is useful; force expand for other panels.
  if (settings.compactMode && which !== "content") {
    void setCompactMode(false, { skipPanel: true });
  }

  els.setup?.classList.toggle("hidden", which !== "setup");
  els.loading?.classList.toggle("hidden", which !== "loading");
  els.error?.classList.toggle("hidden", which !== "error");
  els.content?.classList.toggle("hidden", which !== "content");
  els.settings?.classList.toggle("hidden", which !== "settings");
  syncCompactUi();
}

function levelClass(percent: number): string {
  if (percent >= 90) return "level-high";
  if (percent >= 70) return "level-mid";
  return "level-ok";
}

function formatRelative(from: Date): string {
  const secs = Math.max(0, Math.floor((Date.now() - from.getTime()) / 1000));
  if (secs < 15) return "just now";
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function updateLastUpdatedLabel() {
  if (!els.lastUpdated) return;
  if (!lastFetchedAt) {
    els.lastUpdated.textContent = "Not updated yet";
    return;
  }
  els.lastUpdated.textContent = `Updated ${formatRelative(lastFetchedAt)}`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function friendlyError(raw: string): string {
  const t = raw.toLowerCase();
  if (t.includes("logged in") || t.includes("sign in")) {
    return (
      "We couldn't see your usage - it looks like you aren't signed in yet.\n\n" +
      "Click Try again, sign in when the browser opens, then wait for the usage page."
    );
  }
  if (t.includes("parse usage") || t.includes("could not parse")) {
    return (
      "We opened grok.com but couldn't read the usage numbers.\n\n" +
      "Make sure you're signed in and can see your Weekly SuperGrok limit in the browser, then try again."
    );
  }
  if (t.includes("scrape runtime") || t.includes("npm install") || t.includes("playwright install")) {
    return (
      "First-time setup is still installing helpers (this needs internet).\n\n" +
      "Stay online and click Try again. This only happens once and can take a few minutes."
    );
  }
  if (t.includes("node") && (t.includes("not found") || t.includes("failed to start"))) {
    return (
      "Couldn't start the helper tools.\n\n" +
      "Check your internet connection and try again. The app can download what it needs automatically."
    );
  }
  return raw.length > 400 ? raw.slice(0, 400) + "…" : raw;
}

async function updateTrayTooltip(percent: number | null, resetsHint?: string) {
  if (!IN_TAURI) return;
  let text = "Grok Usage";
  if (percent != null && !Number.isNaN(percent)) {
    const pct = Math.round(percent);
    text = `${pct}% SuperGrok used`;
    if (resetsHint) text += ` · Resets ${resetsHint}`;
  }
  try {
    await invoke("set_tray_tooltip", { text });
  } catch (e) {
    console.error("tray tooltip", e);
  }
}

function syncCompactUi() {
  const compact = !!settings.compactMode;
  els.app?.classList.toggle("compact", compact);
  els.btnCompact?.classList.toggle("active", compact);
  els.btnCompact?.setAttribute(
    "title",
    compact ? "Exit sleek mode" : "Sleek mode — compact pill while you code"
  );
  els.btnCompact?.setAttribute(
    "aria-label",
    compact ? "Exit sleek mode" : "Sleek mode"
  );

  // Sleek bar only when compact + we have content data
  const showSleek =
    compact && lastOverallPercent != null && els.content && !els.content.classList.contains("hidden");
  // When compact, content section is hidden via CSS; sleek bar replaces it
  if (compact && lastOverallPercent != null) {
    els.sleekBar?.classList.remove("hidden");
  } else {
    els.sleekBar?.classList.add("hidden");
  }
  void showSleek;
}

function updateSleekBar(percent: number, resetsHint: string) {
  const pct = Math.round(percent);
  if (els.sleekPercent) els.sleekPercent.textContent = `${pct}%`;
  if (els.sleekFill) {
    els.sleekFill.style.width = `${Math.min(100, percent)}%`;
    els.sleekFill.className = `sleek-fill ${levelClass(percent)}`;
  }
  if (els.sleekLabel) {
    els.sleekLabel.textContent = resetsHint ? `Resets ${resetsHint}` : "used";
  }
}

async function setCompactMode(
  enabled: boolean,
  opts?: { skipPanel?: boolean }
): Promise<void> {
  if (!IN_TAURI) {
    settings.compactMode = enabled;
    syncCompactUi();
    return;
  }

  // Need live data before going sleek
  if (enabled && lastOverallPercent == null) {
    return;
  }

  try {
    const next = await invoke<AppSettings>("set_compact_mode", { enabled });
    settings = next;
    syncPinButton();
    if (els.setAot) els.setAot.checked = settings.alwaysOnTop;
    syncCompactUi();
    if (enabled && !opts?.skipPanel) {
      showPanel("content");
    }
  } catch (e) {
    console.error(e);
  }
}

function renderUsage(data: UsageSnapshot) {
  const pct = Math.round(data.overallPercent);

  if (els.overallPct) els.overallPct.textContent = `${pct}%`;
  if (els.overallLabel) els.overallLabel.textContent = `${pct}% used`;
  if (els.overallFill) {
    els.overallFill.style.width = `${Math.min(100, data.overallPercent)}%`;
    els.overallFill.className = `progress-fill ${levelClass(data.overallPercent)}`;
  }

  if (els.categoryList) {
    els.categoryList.innerHTML = data.categories
      .map(
        (c) => `
      <li class="category">
        <span class="category-name">${escapeHtml(c.name)}</span>
        <span class="category-pct">${Math.round(c.percent)}%</span>
        <div class="progress" role="progressbar" aria-valuenow="${c.percent}" aria-valuemin="0" aria-valuemax="100">
          <div class="progress-fill ${levelClass(c.percent)}" style="width: ${Math.min(100, c.percent)}%"></div>
        </div>
      </li>`
      )
      .join("");
  }

  const date = data.resetsDate || data.resetsDisplay || "";
  const time = data.resetsTime || "";
  if (els.resetsDate) {
    els.resetsDate.textContent = date ? `Resets ${date}` : "Reset time unknown";
  }
  if (els.resetsTime) {
    els.resetsTime.textContent = time ? `at ${time}` : "";
  }

  // Short hint for tray + sleek bar (prefer date only)
  const resetsHint = (data.resetsDate || data.resetsDisplay || "").trim();
  lastOverallPercent = data.overallPercent;
  updateSleekBar(data.overallPercent, resetsHint);
  void updateTrayTooltip(data.overallPercent, resetsHint);

  const credits = data.extraCredits;
  const hasCredits = credits != null && !Number.isNaN(credits);
  if (els.creditsBlock) {
    els.creditsBlock.classList.toggle("hidden", !hasCredits);
  }
  if (els.creditsValue && hasCredits) {
    els.creditsValue.textContent =
      data.extraCreditsLabel?.trim() ||
      `$${Number(credits).toFixed(2)}`;
  }

  if (els.dataNote) {
    if (data.note) {
      els.dataNote.textContent = data.note;
      els.dataNote.classList.remove("hidden");
    } else {
      els.dataNote.textContent = "";
      els.dataNote.classList.add("hidden");
    }
  }

  lastFetchedAt = new Date(data.fetchedAt);
  lastWasLive = true;
  updateLastUpdatedLabel();
  showPanel("content");
  syncCompactUi();
}

// -- Settings / fetch -------------------------------------------------------

async function loadSettings() {
  if (!IN_TAURI) {
    syncSettingsForm();
    syncPinButton();
    syncCompactUi();
    return;
  }
  try {
    settings = await invoke<AppSettings>("get_settings");
    settings.headedForLogin ??= true;
    settings.alwaysHeaded ??= false;
    settings.setupComplete ??= false;
    settings.compactMode ??= false;
    syncSettingsForm();
    syncPinButton();
    syncCompactUi();
    scheduleAutoRefresh();
  } catch (e) {
    console.error(e);
  }
}

function syncSettingsForm() {
  if (els.setRefresh)
    els.setRefresh.value = String(settings.refreshIntervalMinutes);
  if (els.setAot) els.setAot.checked = settings.alwaysOnTop;
  if (els.setHeaded) els.setHeaded.checked = settings.headedForLogin;
  if (els.setAlwaysHeaded) els.setAlwaysHeaded.checked = settings.alwaysHeaded;
  if (els.setChannel) els.setChannel.value = settings.browserChannel ?? "";
  if (els.setProfile) els.setProfile.value = settings.browserUserDataDir ?? "";
}

function syncPinButton() {
  els.btnPin?.classList.toggle("active", settings.alwaysOnTop);
}

function scheduleAutoRefresh() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
  if (!IN_TAURI) return;
  const mins = settings.refreshIntervalMinutes;
  if (mins > 0) {
    refreshTimer = setInterval(() => {
      void refreshUsage(false);
    }, mins * 60 * 1000);
  }
}

async function persistSettings(next: AppSettings) {
  if (!IN_TAURI) {
    settings = next;
    return;
  }
  settings = await invoke<AppSettings>("save_settings", { newSettings: next });
}

async function refreshUsage(showLoading = true, opts?: { connecting?: boolean }) {
  if (loading) return;
  loading = true;
  if (els.btnRefresh) els.btnRefresh.disabled = true;

  // Quiet refresh while in sleek mode — keep the pill visible (no loading panel)
  const quietCompact = settings.compactMode && !showLoading;

  if (showLoading && !quietCompact) {
    showPanel("loading");
    if (els.loadingTitle) {
      els.loadingTitle.textContent = opts?.connecting
        ? "Connecting to Grok…"
        : "Getting your usage…";
    }
    if (els.loadingHint) {
      els.loadingHint.textContent = opts?.connecting
        ? "A browser may open — sign in, then wait. First time can take a few minutes."
        : "Hang tight. This usually takes under a minute.";
    }
  }

  try {
    if (!IN_TAURI) {
      showPanel("error");
      if (els.errorMsg) {
        els.errorMsg.textContent =
          "Open the Grok Usage desktop app (not a browser tab) to load real data.";
      }
      return;
    }

    const res = await invoke<UsageResponse>("get_usage");
    if (res.data && (res.ok || res.data.overallPercent > 0 || res.data.categories.length)) {
      renderUsage(res.data);
      const next = {
        ...settings,
        setupComplete: true,
      };
      await persistSettings(next);
      scheduleAutoRefresh();
      if (!res.ok && res.error && els.dataNote) {
        els.dataNote.textContent = friendlyError(res.error);
        els.dataNote.classList.remove("hidden");
      }
    } else {
      showPanel("error");
      if (els.errorMsg) {
        els.errorMsg.textContent = friendlyError(
          res.error ?? "We couldn't load your usage. Please try again."
        );
      }
    }
  } catch (e) {
    showPanel("error");
    if (els.errorMsg) {
      els.errorMsg.textContent = friendlyError(
        e instanceof Error ? e.message : String(e)
      );
    }
  } finally {
    loading = false;
    if (els.btnRefresh) els.btnRefresh.disabled = false;
  }
}

async function startConnectFlow() {
  const next: AppSettings = {
    ...settings,
    headedForLogin: true,
    alwaysHeaded: true,
    setupComplete: false,
    compactMode: false,
  };
  try {
    await persistSettings(next);
    syncSettingsForm();
    scheduleAutoRefresh();
    await refreshUsage(true, { connecting: true });
    if (lastWasLive) {
      const quiet: AppSettings = {
        ...settings,
        alwaysHeaded: false,
        headedForLogin: true,
        setupComplete: true,
      };
      await persistSettings(quiet);
      syncSettingsForm();
    }
  } catch (e) {
    showPanel("error");
    if (els.errorMsg) {
      els.errorMsg.textContent = friendlyError(
        e instanceof Error ? e.message : String(e)
      );
    }
  }
}

async function saveSettingsFromForm() {
  const next: AppSettings = {
    ...settings,
    refreshIntervalMinutes: Math.max(
      0,
      parseInt(els.setRefresh?.value ?? "5", 10) || 0
    ),
    alwaysOnTop: els.setAot?.checked ?? true,
    headedForLogin: els.setHeaded?.checked ?? true,
    alwaysHeaded: els.setAlwaysHeaded?.checked ?? false,
    browserChannel: (els.setChannel?.value ?? "").trim() || null,
    browserUserDataDir: els.setProfile?.value.trim() || null,
  };

  try {
    await persistSettings(next);
    syncPinButton();
    scheduleAutoRefresh();
    if (!next.setupComplete && !lastWasLive) {
      showPanel("setup");
    } else {
      await refreshUsage(true);
    }
  } catch (e) {
    alert(`Couldn't save settings: ${e}`);
  }
}

// -- Events -----------------------------------------------------------------

function wireEvents() {
  els.btnRefresh?.addEventListener("click", () => void refreshUsage(false));
  els.btnRetry?.addEventListener("click", () => void refreshUsage(true, { connecting: true }));
  els.btnErrorSetup?.addEventListener("click", () => showPanel("setup"));
  els.btnConnect?.addEventListener("click", () => void startConnectFlow());

  els.btnOpenUsage?.addEventListener("click", () => {
    if (IN_TAURI) void openUrl("https://grok.com/?_s=usage");
    else window.open("https://grok.com/?_s=usage", "_blank");
  });

  els.btnPin?.addEventListener("click", async () => {
    const next = !settings.alwaysOnTop;
    if (!IN_TAURI) {
      settings.alwaysOnTop = next;
      syncPinButton();
      return;
    }
    try {
      await invoke("set_always_on_top", { enabled: next });
      settings.alwaysOnTop = next;
      syncPinButton();
      if (els.setAot) els.setAot.checked = next;
    } catch (e) {
      console.error(e);
    }
  });

  els.btnCompact?.addEventListener("click", () => {
    if (!lastWasLive && lastOverallPercent == null) {
      // No data yet — can't go sleek
      return;
    }
    void setCompactMode(!settings.compactMode);
  });

  els.btnSleekExpand?.addEventListener("click", (e) => {
    e.stopPropagation();
    void setCompactMode(false);
  });

  els.btnMinimize?.addEventListener("click", () => {
    if (IN_TAURI) void invoke("hide_window");
  });

  els.btnSettings?.addEventListener("click", () => {
    syncSettingsForm();
    showPanel("settings");
  });

  els.btnSettingsCancel?.addEventListener("click", () => {
    if (lastFetchedAt) showPanel("content");
    else if (settings.setupComplete || lastWasLive) void refreshUsage(true);
    else showPanel("setup");
  });

  els.btnSettingsSave?.addEventListener("click", () => {
    void saveSettingsFromForm();
  });
}

// -- Boot -------------------------------------------------------------------

window.addEventListener("DOMContentLoaded", async () => {
  wireEvents();
  setInterval(updateLastUpdatedLabel, 15_000);

  await loadSettings();
  void updateTrayTooltip(null);

  if (!IN_TAURI) {
    showPanel("setup");
    return;
  }

  if (!settings.setupComplete) {
    // Don't start in compact until connected
    if (settings.compactMode) {
      await setCompactMode(false);
    }
    showPanel("setup");
    return;
  }

  await refreshUsage(true);

  // After first data, re-apply compact if user left it on
  if (settings.compactMode && lastOverallPercent != null) {
    await setCompactMode(true);
  }

  if (IN_TAURI) {
    try {
      await listen("tray-refresh", () => {
        void refreshUsage(false);
      });
    } catch {
      /* ignore */
    }
  }
});
