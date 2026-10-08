import type { ChatProviderKind, Settings } from "./types";

export interface PowerState {
  charging: boolean;
  source: "battery-api" | "override" | "unknown";
}

/**
 * Firefox has no Battery Status API, so "auto" falls back to treating the
 * machine as on battery. The user can force the state in preferences.
 */
export async function readPowerState(settings: Settings): Promise<PowerState> {
  const override = settings.providerStrategy.chargingOverride;
  if (override === "charging") return { charging: true, source: "override" };
  if (override === "battery") return { charging: false, source: "override" };

  const nav = navigator as Navigator & {
    getBattery?: () => Promise<{ charging: boolean }>;
  };
  if (typeof nav.getBattery === "function") {
    try {
      const battery = await nav.getBattery();
      return { charging: Boolean(battery.charging), source: "battery-api" };
    } catch {
      // fall through
    }
  }
  return { charging: false, source: "unknown" };
}

export function isOnline(): boolean {
  try {
    return navigator.onLine !== false;
  } catch {
    return true;
  }
}

export interface ChainEntry {
  kind: ChatProviderKind;
  reason: string;
}

export function providerLabel(kind: ChatProviderKind): string {
  if (kind === "opencode-go") return "OpenCode Go";
  if (kind === "ollama") return "Ollama";
  return "vLLM";
}

/**
 * Resolve the ordered list of providers to try for a request.
 * Precedence: token-saving local preference -> offline override -> configured
 * active provider, with a local fallback when enabled.
 */
export function resolveProviderChain(
  settings: Settings,
  power: PowerState,
  online: boolean = isOnline(),
): ChainEntry[] {
  const strategy = settings.providerStrategy;
  const local = strategy.localProvider;
  const remote = settings.activeProvider;
  const chain: ChainEntry[] = [];
  const push = (kind: ChatProviderKind, reason: string) => {
    if (!chain.some((entry) => entry.kind === kind)) chain.push({ kind, reason });
  };

  if (strategy.preferLocal) {
    const useLocal = !strategy.localOnlyWhenCharging || power.charging;
    if (useLocal) {
      push(local, power.charging ? "local · charging" : "local · saving tokens");
      if (online) push(remote, "remote fallback");
    } else {
      push(remote, "remote · on battery");
      push(local, "local fallback");
    }
  } else {
    push(remote, "active provider");
    if (strategy.fallbackToLocalWhenOffline) push(local, "local fallback");
  }

  if (!online) {
    const localEntry = chain.find((entry) => entry.kind === local);
    if (localEntry) return [{ kind: local, reason: "local · offline" }];
  }
  return chain;
}
