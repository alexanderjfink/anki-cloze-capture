import { escapeHtml } from "../lib/anki";
import { fuzzyQuote, getPageText, locateAnchor } from "../lib/anchor";
import { autosize, autosizeAll } from "../preview/autosize";
import type { AnkiNoteInfo, Annotation } from "../lib/types";

const STYLES = `
:host { all: initial; }
.acc-pop {
  position: fixed; z-index: 2147483647; width: 390px; max-width: calc(100vw - 24px);
  max-height: 62vh; display: flex; flex-direction: column;
  background:#1e1f24; color:#e7e7ea; border:1px solid #3a3c45; border-radius:11px;
  box-shadow:0 12px 40px rgba(0,0,0,.5);
  font:13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
}
.acc-floater {
  position: fixed; right: 18px; bottom: 18px; z-index: 2147483647;
  display:flex; align-items:center; gap:8px; cursor:pointer;
  background:#1e1f24; color:#e7e7ea; border:1px solid #3a3c45; border-radius:999px;
  padding:8px 14px; box-shadow:0 8px 26px rgba(0,0,0,.45);
  font:600 12px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
}
.acc-floater:hover { background:#26272e; }
.acc-floater .acc-count { background:#3b6fd4; color:#fff; border-radius:999px; padding:2px 8px; font-size:11px; }
.acc-pagepanel {
  position: fixed; right: 18px; bottom: 64px; z-index: 2147483647;
  width: 430px; max-width: calc(100vw - 32px); max-height: 72vh; display:flex; flex-direction:column;
  background:#1e1f24; color:#e7e7ea; border:1px solid #3a3c45; border-radius:11px;
  box-shadow:0 12px 44px rgba(0,0,0,.5);
  font:13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
}
.acc-head { display:flex; align-items:center; gap:8px; padding:9px 11px; border-bottom:1px solid #3a3c45; }
.acc-title { font-weight:600; font-size:12px; flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.acc-body { padding:10px 11px; overflow:auto; }
.acc-group { border:1px solid #33353e; border-radius:9px; padding:8px 9px; margin-bottom:10px; }
.acc-group-head { display:flex; align-items:baseline; gap:6px; margin-bottom:6px; }
.acc-group-title { font-size:12px; font-weight:600; flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.acc-group-src { color:#8f95a3; font-size:10px; }
.acc-note { border:1px solid #33353e; border-radius:9px; padding:8px 9px; margin-bottom:9px; }
.acc-note-head { display:flex; align-items:center; gap:6px; margin-bottom:6px; }
.acc-model { font-size:11px; color:#9aa0ad; }
.acc-orphan { color:#f2c98a; font-size:12px; }
.acc-field { margin-bottom:6px; }
.acc-field label { display:block; font-size:11px; color:#9aa0ad; margin-bottom:3px; }
.acc-field textarea { width:100%; box-sizing:border-box; background:#1b1c21; color:#e7e7ea; border:1px solid #40424c; border-radius:6px; padding:6px 7px; font:12px/1.4 ui-monospace, Menlo, monospace; resize:vertical; }
.acc-thumb { max-width:100%; max-height:120px; border-radius:6px; display:block; background:#111; }
.acc-src { font-size:11px; color:#8f95a3; margin-top:3px; word-break:break-all; }
.acc-foot { display:flex; gap:7px; padding:9px 11px; border-top:1px solid #3a3c45; }
.acc-btn { border:1px solid #454754; background:#2c2d35; color:#e7e7ea; border-radius:7px; padding:5px 10px; cursor:pointer; font-size:12px; }
.acc-btn:hover { background:#35363f; }
.acc-btn.primary { background:#3b6fd4; border-color:#3b6fd4; color:#fff; }
.acc-btn.danger { color:#f2a1a1; }
.acc-spacer { flex:1; }
.acc-err { font-size:11px; color:#f2a1a1; }
`;

export function splitSource(value: string): { body: string; source: string } {
  const match = value.match(/(?:<br\s*\/?>\s*)*Source:\s*<a\s[^>]*>.*?<\/a>\s*$/i);
  if (match && match.index !== undefined) {
    return { body: value.slice(0, match.index), source: match[0] };
  }
  return { body: value, source: "" };
}

/** If the range ends inside a word, extend it to the end of that word. */
function snapRangeEndToWord(range: Range): void {
  const node = range.endContainer;
  if (node.nodeType !== Node.TEXT_NODE) return;
  const text = node as Text;
  const isWord = (ch: string) => /[A-Za-z0-9]/.test(ch);
  let offset = range.endOffset;
  if (offset > 0 && offset < text.data.length && isWord(text.data[offset - 1]) && isWord(text.data[offset])) {
    while (offset < text.data.length && isWord(text.data[offset])) offset += 1;
    range.setEnd(text, offset);
  }
}

function renderImageValue(value: string): string {
  const img = value.match(/<img\s+[^>]*src=["']?([^"'\s>]+)/i);
  const src = img?.[1] ?? "";
  const url = /^[a-z]+:/i.test(src) ? src : "";
  return `<span class="acc-model">Image field</span>${url ? `<img class="acc-thumb" src="${escapeHtml(url)}" alt="">` : ""}`;
}

export class MarkerLayer {
  private host: HTMLDivElement;
  private shadow: ShadowRoot;
  private popover: HTMLDivElement;
  private floater: HTMLButtonElement;
  private pagePanel: HTMLDivElement;
  private badges = new Map<string, HTMLElement>();
  private annotations: Annotation[] = [];
  private enabled = false;
  private currentUrl = location.href;
  private observer: MutationObserver | null = null;
  private rescanTimer: ReturnType<typeof setTimeout> | null = null;
  private popoverOpen = false;
  private pageOpen = false;

  constructor() {
    this.host = document.createElement("div");
    this.host.className = "acc-marker-host";
    this.host.style.cssText = "all:initial;";
    this.shadow = this.host.attachShadow({ mode: "open" });
    this.shadow.innerHTML = `<style>${STYLES}</style>`;

    this.popover = document.createElement("div");
    this.popover.className = "acc-pop";
    this.popover.style.display = "none";

    this.floater = document.createElement("button");
    this.floater.className = "acc-floater";
    this.floater.style.display = "none";
    this.floater.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.togglePagePanel();
    });

    this.pagePanel = document.createElement("div");
    this.pagePanel.className = "acc-pagepanel";
    this.pagePanel.style.display = "none";

    this.shadow.appendChild(this.popover);
    this.shadow.appendChild(this.pagePanel);
    this.shadow.appendChild(this.floater);
    document.documentElement.appendChild(this.host);
    this.shadow.addEventListener("click", (event) => void this.onClick(event));
    this.shadow.addEventListener("input", (event) => {
      const target = event.target as HTMLElement | null;
      if (target instanceof HTMLTextAreaElement) autosize(target);
    });
    document.addEventListener("mousedown", this.onDocumentMouseDown, true);

    this.observer = new MutationObserver(() => this.scheduleRescan());
  }

  /** Close the note editor when clicking anywhere outside it. */
  private onDocumentMouseDown = (event: MouseEvent): void => {
    const target = event.target as Node | null;
    if (target && this.host.contains(target)) return;
    if (this.popoverOpen) this.hidePopover();
    if (this.pageOpen) this.closePagePanel();
  };

  private async send<T>(message: unknown): Promise<T> {
    return (await browser.runtime.sendMessage(message)) as T;
  }

  async refresh(url = location.href): Promise<void> {
    this.currentUrl = url;
    if (!this.enabled) {
      this.clearBadges();
      return;
    }
    const response = await this.send<{ annotations?: Annotation[] }>({ type: "GET_ANNOTATIONS", url });
    this.annotations = response?.annotations ?? [];
    this.render();
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) {
      this.clearBadges();
      this.hidePopover();
      this.closePagePanel();
    } else {
      void this.refresh();
    }
  }

  private render(): void {
    this.clearBadges();
    if (!this.enabled) {
      this.renderFloater();
      return;
    }
    for (const annotation of this.annotations) this.placeBadge(annotation);
    this.observer?.disconnect();
    if (this.annotations.length > 0 && document.body) {
      this.observer?.observe(document.body, { childList: true, subtree: true });
    }
    this.renderFloater();
    if (this.pageOpen) void this.openPagePanel();
  }

  private totalNotes(): number {
    return this.annotations.reduce((sum, a) => sum + a.noteIds.length, 0);
  }

  private renderFloater(): void {
    const count = this.totalNotes();
    const show = this.enabled && count > 0;
    this.floater.style.display = show ? "flex" : "none";
    if (show) {
      this.floater.innerHTML = `<span>Anki notes</span><span class="acc-count">${count}</span>`;
    } else {
      this.closePagePanel();
    }
  }

  private placeBadge(annotation: Annotation): void {
    const existing = this.badges.get(annotation.id);
    if (existing?.isConnected) return;
    // Recovered annotations have an empty anchor; fall back to (fuzzy) card text.
    let anchor = annotation.anchor;
    if (!anchor.quote && annotation.preview) {
      const quote = fuzzyQuote(getPageText(document.body), annotation.preview) ?? annotation.preview;
      anchor = { kind: "text", quote, prefix: "", suffix: "" };
    }
    const located = locateAnchor(anchor);
    if (!located) return;
    const badge = this.createBadge(annotation);
    try {
      if (located.range) {
        const range = located.range.cloneRange();
        range.collapse(false);
        snapRangeEndToWord(range);
        range.insertNode(badge);
      } else if (located.element) {
        located.element.insertAdjacentElement("afterend", badge);
      } else {
        return;
      }
    } catch {
      return;
    }
    this.badges.set(annotation.id, badge);
  }

  private createBadge(annotation: Annotation): HTMLElement {
    const badge = document.createElement("span");
    badge.className = "acc-mark";
    badge.dataset.accId = annotation.id;
    badge.title = annotation.preview || "Anki note";
    badge.style.cssText =
      "display:inline-block;width:9px;height:9px;margin-left:3px;border-radius:50%;background:#3b6fd4;" +
      "box-shadow:0 0 0 2px rgba(59,111,212,.28);cursor:pointer;vertical-align:super;";
    badge.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void this.openPopover(annotation, badge);
    });
    return badge;
  }

  private clearBadges(): void {
    for (const badge of this.badges.values()) badge.remove();
    this.badges.clear();
  }

  private scheduleRescan(): void {
    if (this.rescanTimer) clearTimeout(this.rescanTimer);
    this.rescanTimer = setTimeout(() => {
      if (!this.enabled) return;
      for (const annotation of this.annotations) {
        const badge = this.badges.get(annotation.id);
        if (!badge || !badge.isConnected) {
          this.badges.delete(annotation.id);
          this.placeBadge(annotation);
        }
      }
    }, 400);
  }

  private hidePopover(): void {
    this.popoverOpen = false;
    this.popover.style.display = "none";
    this.popover.innerHTML = "";
  }

  private closePagePanel(): void {
    this.pageOpen = false;
    this.pagePanel.style.display = "none";
    this.pagePanel.innerHTML = "";
  }

  private positionPopover(anchor: HTMLElement): void {
    const rect = anchor.getBoundingClientRect();
    const width = 390;
    let left = Math.min(rect.left, window.innerWidth - width - 12);
    left = Math.max(12, left);
    let top = rect.bottom + 8;
    if (top + 240 > window.innerHeight) top = Math.max(12, rect.top - 250);
    this.popover.style.left = `${left}px`;
    this.popover.style.top = `${top}px`;
  }

  // --- single-note popover (from a badge) ---

  private async openPopover(annotation: Annotation, anchor: HTMLElement): Promise<void> {
    this.closePagePanel();
    this.positionPopover(anchor);
    this.popoverOpen = true;
    this.popover.style.display = "flex";
    this.popover.innerHTML = `<div class="acc-body"><span class="acc-model">Loading note…</span></div>`;
    const response = await this.send<{ ok: boolean; notes?: AnkiNoteInfo[]; error?: string }>({
      type: "GET_NOTE_DETAILS",
      noteIds: annotation.noteIds,
    });
    if (!this.popoverOpen) return;
    this.renderPopover(annotation, response?.notes ?? [], response?.error);
  }

  private renderPopover(annotation: Annotation, notes: AnkiNoteInfo[], error?: string): void {
    const head = `<div class="acc-head"><span class="acc-title">${escapeHtml(annotation.preview || annotation.title)}</span><button class="acc-btn" data-acc-action="close">✕</button></div>`;
    if (error) {
      this.popover.innerHTML = `${head}<div class="acc-body"><div class="acc-err">${escapeHtml(error)}</div></div>`;
      return;
    }
    this.popover.innerHTML = `${head}<div class="acc-body">${this.annotationBody(annotation, notes)}</div>`;
    autosizeAll(this.popover);
  }

  // --- page-wide panel (from the floater) ---

  private togglePagePanel(): void {
    if (this.pageOpen) this.closePagePanel();
    else void this.openPagePanel();
  }

  private async openPagePanel(): Promise<void> {
    this.hidePopover();
    this.pageOpen = true;
    this.pagePanel.style.display = "flex";
    const allIds = [...new Set(this.annotations.flatMap((a) => a.noteIds))];
    this.pagePanel.innerHTML = `<div class="acc-head"><span class="acc-title">Anki notes on this page (${allIds.length})</span><button class="acc-btn" data-acc-action="page-close">✕</button></div><div class="acc-body"><span class="acc-model">Loading…</span></div>`;
    const response = await this.send<{ ok: boolean; notes?: AnkiNoteInfo[]; error?: string }>({
      type: "GET_NOTE_DETAILS",
      noteIds: allIds,
    });
    if (!this.pageOpen) return;
    const notes = response?.notes ?? [];
    const head = `<div class="acc-head"><span class="acc-title">Anki notes on this page (${allIds.length})</span><button class="acc-btn" data-acc-action="page-close">✕</button></div>`;
    if (response?.error) {
      this.pagePanel.innerHTML = `${head}<div class="acc-body"><div class="acc-err">${escapeHtml(response.error)}</div></div>`;
      return;
    }
    const body = this.annotations
      .map((annotation) => {
        const mine = notes.filter((n) => annotation.noteIds.includes(n.noteId));
        return `<div class="acc-group">
          <div class="acc-group-head"><span class="acc-group-title">${escapeHtml(annotation.preview || annotation.title)}</span><span class="acc-group-src">${escapeHtml(annotation.deck)}</span></div>
          ${this.annotationBody(annotation, mine)}
        </div>`;
      })
      .join("");
    this.pagePanel.innerHTML = `${head}<div class="acc-body">${body || `<span class="acc-model">No notes found.</span>`}</div>`;
    autosizeAll(this.pagePanel);
  }

  private annotationBody(annotation: Annotation, notes: AnkiNoteInfo[]): string {
    const notesHtml = notes.map((note) => this.noteEditorsHtml(note)).join("");
    const found = new Set(notes.map((n) => n.noteId));
    const orphans = annotation.noteIds.filter((id) => !found.has(id));
    const orphanHtml = orphans
      .map(
        (id) => `<div class="acc-note"><div class="acc-orphan">Note ${id} was removed in Anki.</div>
          <div class="acc-foot"><div class="acc-spacer"></div><button class="acc-btn danger" data-acc-action="remove" data-acc-id="${escapeHtml(annotation.id)}">Remove marker</button></div></div>`,
      )
      .join("");
    return `${notesHtml}${orphanHtml}${notesHtml || orphanHtml ? "" : `<span class="acc-model">No notes found.</span>`}`;
  }

  private noteEditorsHtml(note: AnkiNoteInfo): string {
    const fields = Object.entries(note.fields)
      .map(([name, value]) => {
        if (/<img\s/i.test(value)) {
          return `<div class="acc-field"><label>${escapeHtml(name)}</label>${renderImageValue(value)}</div>`;
        }
        const { body, source } = splitSource(value);
        return `<div class="acc-field"><label>${escapeHtml(name)}</label>
          <textarea rows="3" data-acc-field="${escapeHtml(name)}" data-acc-source="${escapeHtml(source)}">${escapeHtml(body)}</textarea>
          ${source ? `<div class="acc-src">${escapeHtml(source.replace(/<[^>]+>/g, "").trim())}</div>` : ""}
        </div>`;
      })
      .join("");
    return `<div class="acc-note" data-acc-note="${note.noteId}">
      <div class="acc-note-head"><span class="acc-model">${escapeHtml(note.modelName)}</span></div>
      ${fields}
      <div class="acc-foot"><div class="acc-spacer"></div><button class="acc-btn primary" data-acc-action="save" data-acc-note="${note.noteId}">Save</button></div>
    </div>`;
  }

  private async onClick(event: Event): Promise<void> {
    const target = event.target as HTMLElement | null;
    const actionEl = target?.closest<HTMLElement>("[data-acc-action]");
    if (!actionEl) return;
    const action = actionEl.dataset.accAction;

    if (action === "close") {
      this.hidePopover();
      return;
    }
    if (action === "page-close") {
      this.closePagePanel();
      return;
    }
    if (action === "remove") {
      const id = actionEl.dataset.accId as string;
      await this.send({ type: "REMOVE_ANNOTATION", id, url: this.currentUrl });
      this.annotations = this.annotations.filter((a) => a.id !== id);
      this.badges.get(id)?.remove();
      this.badges.delete(id);
      this.hidePopover();
      this.renderFloater();
      if (this.pageOpen) void this.openPagePanel();
      return;
    }
    if (action === "save") {
      const noteEl = actionEl.closest<HTMLElement>("[data-acc-note]");
      const noteId = Number(actionEl.dataset.accNote);
      if (!noteEl || !noteId) return;
      const fields: Record<string, string> = {};
      noteEl.querySelectorAll<HTMLTextAreaElement>("[data-acc-field]").forEach((el) => {
        const name = el.dataset.accField as string;
        if (!name) return;
        fields[name] = el.value + (el.dataset.accSource ?? "");
      });
      actionEl.textContent = "Saving…";
      const response = await this.send<{ ok: boolean; error?: string }>({
        type: "UPDATE_NOTE",
        noteId,
        fields,
      });
      actionEl.textContent = response?.ok ? "Saved" : "Save failed";
      if (!response?.ok && response?.error) actionEl.title = response.error;
      return;
    }
  }

  destroy(): void {
    this.observer?.disconnect();
    document.removeEventListener("mousedown", this.onDocumentMouseDown, true);
    this.clearBadges();
    this.host.remove();
  }
}
