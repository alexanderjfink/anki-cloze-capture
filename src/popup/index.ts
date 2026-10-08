import { getSettings, saveSettings } from "../lib/storage";
import { providerLabel } from "../lib/strategy";
import type { ChargingOverride, RecentBatch } from "../lib/types";

const dot = document.getElementById("dot");
const statusText = document.getElementById("status-text");
const recentEl = document.getElementById("recent");
const powerBtn = document.getElementById("power") as HTMLButtonElement | null;
const markersBtn = document.getElementById("markers") as HTMLButtonElement | null;

function renderRecent(batches: RecentBatch[]): void {
  if (!recentEl) return;
  if (batches.length === 0) {
    recentEl.innerHTML = '<div class="empty">Nothing added yet.</div>';
    return;
  }
  recentEl.innerHTML = batches
    .slice(0, 6)
    .map((batch) => {
      const when = new Date(batch.createdAt).toLocaleString();
      return `<div class="batch">
        <div class="top">
          <span class="deck">${escapeHtml(batch.deck)} · ${batch.count} card${batch.count === 1 ? "" : "s"}</span>
          <button data-undo="${batch.id}">Undo</button>
        </div>
        <div class="muted" style="font-size:11px">${escapeHtml(when)}</div>
      </div>`;
    })
    .join("");
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);
}

async function refreshStatus(): Promise<void> {
  try {
    const response = (await browser.runtime.sendMessage({ type: "PING" })) as {
      ok: boolean;
      anki: boolean;
      provider: string;
      model: string;
      effectiveProvider?: string;
      strategyNote?: string;
    };
    const kind = (response.effectiveProvider ?? response.provider) as Parameters<typeof providerLabel>[0];
    const label = `${providerLabel(kind)}${response.strategyNote ? ` · ${response.strategyNote}` : ""}`;
    if (response.anki) {
      dot?.classList.add("ok");
      dot?.classList.remove("bad");
      if (statusText) statusText.textContent = `AnkiConnect ready · ${label}`;
    } else {
      dot?.classList.add("bad");
      dot?.classList.remove("ok");
      if (statusText) statusText.textContent = `AnkiConnect unreachable · ${label}`;
    }
  } catch {
    dot?.classList.add("bad");
    if (statusText) statusText.textContent = "Background unavailable";
  }
}

const POWER_CYCLE: ChargingOverride[] = ["auto", "charging", "battery"];
const POWER_LABEL: Record<ChargingOverride, string> = {
  auto: "Auto",
  charging: "On AC",
  battery: "On battery",
};

async function refreshPower(): Promise<void> {
  const settings = await getSettings();
  if (powerBtn) powerBtn.textContent = `Power: ${POWER_LABEL[settings.providerStrategy.chargingOverride]}`;
}

async function cyclePower(): Promise<void> {
  const settings = await getSettings();
  const current = settings.providerStrategy.chargingOverride;
  const next = POWER_CYCLE[(POWER_CYCLE.indexOf(current) + 1) % POWER_CYCLE.length];
  settings.providerStrategy.chargingOverride = next;
  await saveSettings(settings);
  await refreshPower();
  await refreshStatus();
}

async function activeUrl(): Promise<string | undefined> {
  try {
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    return tabs[0]?.url;
  } catch {
    return undefined;
  }
}

async function refreshMarkers(): Promise<void> {
  const settings = await getSettings();
  const url = await activeUrl();
  let count = 0;
  if (url) {
    const response = (await browser.runtime.sendMessage({ type: "GET_ANNOTATIONS", url })) as {
      annotations?: unknown[];
    };
    count = response?.annotations?.length ?? 0;
  }
  if (markersBtn) {
    markersBtn.textContent = `Markers: ${settings.annotations.showMarkers ? "On" : "Off"}${count ? ` · ${count} on page` : ""}`;
  }
}

async function toggleMarkers(): Promise<void> {
  const settings = await getSettings();
  settings.annotations.showMarkers = !settings.annotations.showMarkers;
  await saveSettings(settings);
  await refreshMarkers();
}

async function refreshRecent(): Promise<void> {
  const response = (await browser.runtime.sendMessage({ type: "GET_RECENT" })) as {
    ok: boolean;
    batches?: RecentBatch[];
  };
  renderRecent(response?.batches ?? []);
}

document.addEventListener("click", async (event) => {
  const target = event.target as HTMLElement;
  const undoEl = target.closest<HTMLElement>("[data-undo]");
  if (undoEl) {
    const id = undoEl.dataset.undo as string;
    await browser.runtime.sendMessage({ type: "UNDO_BATCH", id });
    await refreshRecent();
    return;
  }
  if (target.id === "open-options") {
    await browser.runtime.sendMessage({ type: "OPEN_OPTIONS" });
    window.close();
  } else if (target.id === "flush") {
    await browser.runtime.sendMessage({ type: "FLUSH_QUEUE" });
    await refreshStatus();
    await refreshRecent();
  } else if (target.id === "power") {
    await cyclePower();
  } else if (target.id === "markers") {
    await toggleMarkers();
  } else if (target.id === "import-hyp") {
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    const tabId = tabs[0]?.id;
    if (tabId !== undefined) {
      try {
        await browser.tabs.sendMessage(tabId, { type: "START_HYPOTHESIS_IMPORT" });
      } catch {
        // no content script on this page
      }
    }
    window.close();
  } else if (target.id === "autogen") {
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    const tabId = tabs[0]?.id;
    if (tabId !== undefined) {
      try {
        await browser.tabs.sendMessage(tabId, { type: "START_AUTOGEN" });
      } catch {
        // no content script on this page
      }
    }
    window.close();
  }
});

void refreshStatus();
void refreshPower();
void refreshMarkers();
void refreshRecent();
