import type { ShortcutSettings } from "./types";

export interface ShortcutApplyResult {
  name: "capture-cloze" | "toggle-edit" | "toggle-markers" | "autogen-page";
  ok: boolean;
  error?: string;
}

export const SHORTCUT_COMMANDS = {
  capture: "capture-cloze",
  edit: "toggle-edit",
  markers: "toggle-markers",
  autogen: "autogen-page",
} as const;

interface KeyLike {
  key: string;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  metaKey?: boolean;
}

const MODIFIER_KEYS = new Set(["Control", "Alt", "Shift", "Meta", "OS", "AltGraph"]);

/**
 * Format a keydown into a WebExtension shortcut string (e.g. "Alt+Shift+A"),
 * or null if the event is only a modifier press.
 */
export function formatShortcut(event: KeyLike): string | null {
  if (MODIFIER_KEYS.has(event.key)) return null;
  const mods: string[] = [];
  if (event.ctrlKey) mods.push("Ctrl");
  if (event.altKey) mods.push("Alt");
  if (event.shiftKey) mods.push("Shift");
  if (event.metaKey) mods.push("Command");

  let key = event.key;
  if (key === " ") key = "Space";
  else if (key.length === 1) key = key.toUpperCase();
  else if (key.startsWith("Arrow")) key = key.slice(5);

  if (mods.length === 0 && !/^F\d{1,2}$/.test(key)) {
    // Firefox requires a modifier for non-function keys.
    return null;
  }
  return [...mods, key].join("+");
}

/** Apply the configured shortcuts to the extension commands. */
export async function applyShortcuts(settings: ShortcutSettings): Promise<ShortcutApplyResult[]> {
  const entries: [ShortcutApplyResult["name"], string][] = [
    [SHORTCUT_COMMANDS.capture, settings.capture],
    [SHORTCUT_COMMANDS.edit, settings.edit],
    [SHORTCUT_COMMANDS.markers, settings.toggleMarkers],
    [SHORTCUT_COMMANDS.autogen, settings.autogen],
  ];
  const results: ShortcutApplyResult[] = [];
  for (const [name, shortcut] of entries) {
    if (typeof browser.commands?.update !== "function") {
      results.push({ name, ok: false, error: "This Firefox build cannot set shortcuts programmatically." });
      continue;
    }
    try {
      await browser.commands.update({ name, shortcut: shortcut || "" });
      results.push({ name, ok: true });
    } catch (error) {
      results.push({ name, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return results;
}
