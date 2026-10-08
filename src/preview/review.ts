import { escapeHtml } from "../lib/anki";
import { autosize, autosizeAll } from "./autosize";
import { thumbSrc } from "./panel";
import type { FinalCard, ImageRef, ImageSide, PageAnchor, RoutedCard } from "../lib/types";

export interface BoardAddResult {
  ok: boolean;
  queued: boolean;
  added: number;
  skipped: number;
  message?: string;
  error?: string;
}

export interface BoardCallbacks {
  onAdd: (groupId: string, cards: FinalCard[], url: string) => Promise<BoardAddResult>;
  onRetry: (jobId: string) => void;
  onOpenOptions: () => void;
}

interface BoardCard {
  kind?: "cloze" | "image";
  text: string;
  backExtra: string;
  deck: string;
  confidence: number;
  issues: string[];
  image?: ImageRef;
  imageSide?: ImageSide;
  bothDirections?: boolean;
  anchor?: PageAnchor;
}

interface BoardGroup {
  id: string;
  url: string;
  label: string;
  note?: string;
  cards: BoardCard[];
  adding: boolean;
  error?: string;
}

interface BoardError {
  id: string;
  label: string;
  message: string;
}

const STYLES = `
:host { all: initial; }
.apb-pill {
  position: fixed; right: 18px; bottom: 18px; z-index: 2147483647;
  display:flex; align-items:center; gap:8px; cursor:pointer;
  background:#1e1f24; color:#e7e7ea; border:1px solid #3a3c45; border-radius:999px;
  padding:8px 14px; box-shadow:0 8px 26px rgba(0,0,0,.45);
  font:600 12px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
}
.apb-pill:hover { background:#26272e; }
.apb-pill .apb-count { background:#3b6fd4; color:#fff; border-radius:999px; padding:2px 8px; font-size:11px; }
.apb-pill .apb-spin { width:12px; height:12px; border:2px solid #4a4c58; border-top-color:#7aa2f7; border-radius:50%; animation:apb-spin .8s linear infinite; }
@keyframes apb-spin { to { transform:rotate(360deg); } }
.apb-panel {
  position: fixed; right: 18px; bottom: 18px; z-index: 2147483647;
  width: 460px; max-width: calc(100vw - 32px); max-height: 80vh;
  display:flex; flex-direction:column;
  background:#1e1f24; color:#e7e7ea; border:1px solid #3a3c45; border-radius:12px;
  box-shadow:0 14px 44px rgba(0,0,0,.5);
  font:13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
}
.apb-head { display:flex; align-items:center; gap:8px; padding:10px 12px; border-bottom:1px solid #3a3c45; }
.apb-controls { display:flex; align-items:center; gap:8px; padding:8px 12px; border-bottom:1px solid #3a3c45; min-width:0; }
.apb-controls label { font-size:11px; color:#9aa0ad; white-space:nowrap; flex:0 0 auto; }
.apb-controls select { flex:1 1 auto; min-width:0; width:100%; max-width:100%; box-sizing:border-box; background:#14151a; color:#e7e7ea; border:1px solid #3a3c45; border-radius:7px; padding:6px 8px; font:12px inherit; }
.apb-title { font-weight:600; font-size:13px; }
.apb-sub { color:#8f95a3; font-size:11px; flex:1; }
.apb-body { padding:10px 12px; overflow:auto; flex:1; }
.apb-group { background:#26272e; border:1px solid #35363f; border-radius:9px; padding:9px 10px; margin-bottom:10px; }
.apb-group-head { display:flex; align-items:center; gap:8px; margin-bottom:6px; }
.apb-group-label { flex:1; font-weight:600; font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.apb-group-src { color:#8f95a3; font-size:10px; }
.apb-card { border-top:1px solid #30323b; padding-top:7px; margin-top:7px; }
.apb-card-top { display:flex; align-items:center; gap:6px; margin-bottom:5px; }
.apb-idx { font-size:11px; color:#9aa0ad; }
.apb-badge { font-size:10px; padding:2px 6px; border-radius:999px; background:#2f5233; color:#a7ecb0; }
.apb-badge.low { background:#4a3a22; color:#f2c98a; }
.apb-del { margin-left:auto; background:none; border:none; color:#e08a8a; cursor:pointer; font-size:11px; }
textarea.apb-input, select.apb-input {
  width:100%; box-sizing:border-box; background:#1b1c21; color:#e7e7ea; border:1px solid #40424c;
  border-radius:6px; padding:6px 7px; font:12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
  resize:vertical; margin-bottom:5px;
}
select.apb-input { font-family:inherit; }
.apb-deck-row { display:flex; align-items:center; gap:6px; min-width:0; }
.apb-deck-row label { font-size:11px; color:#9aa0ad; flex:0 0 auto; }
.apb-deck-row select { min-width:0; }
.apb-issues { color:#f2c98a; font-size:11px; margin-top:4px; }
.apb-thumb { max-width:100%; max-height:200px; border-radius:7px; margin-bottom:5px; display:block; background:#111; }
.apb-check { display:flex; align-items:center; gap:6px; font-size:11px; color:#9aa0ad; margin-bottom:5px; }
.apb-foot { display:flex; gap:7px; padding:10px 12px; border-top:1px solid #3a3c45; }
.apb-btn { border:1px solid #454754; background:#2c2d35; color:#e7e7ea; border-radius:7px; padding:5px 10px; cursor:pointer; font-size:12px; }
.apb-btn:hover { background:#35363f; }
.apb-btn.primary { background:#3b6fd4; border-color:#3b6fd4; color:#fff; }
.apb-btn.primary:hover { background:#4a7ee0; }
.apb-btn.danger { color:#f2a1a1; }
.apb-btn:disabled { opacity:.55; cursor:default; }
.apb-spacer { flex:1; }
.apb-error { border:1px solid #5a2a2a; background:#2a1e1e; border-radius:8px; padding:8px 9px; margin-bottom:8px; }
.apb-hint { color:#8f95a3; font-size:11px; padding:8px 12px; }
.apb-empty { color:#8f95a3; font-size:12px; padding:8px 2px; }
`;

export class ReviewBoard {
  private host: HTMLDivElement;
  private shadow: ShadowRoot;
  private pill: HTMLButtonElement;
  private panel: HTMLDivElement;
  private headerEl: HTMLDivElement;
  private controlsEl: HTMLDivElement;
  private bodyEl: HTMLDivElement;
  private callbacks: BoardCallbacks;
  private groups: BoardGroup[] = [];
  private errors: BoardError[] = [];
  private decks: string[] = [];
  private pending = 0;
  private expanded = false;
  private statusMessage = "";
  private addingAll = false;
  private bulkDeck = "";

  constructor(callbacks: BoardCallbacks) {
    this.callbacks = callbacks;
    this.host = document.createElement("div");
    this.host.style.cssText = "all:initial;";
    this.shadow = this.host.attachShadow({ mode: "open" });
    this.shadow.innerHTML = `<style>${STYLES}</style>`;

    this.pill = document.createElement("button");
    this.pill.className = "apb-pill";
    this.pill.style.display = "none";
    this.pill.addEventListener("click", () => this.setExpanded(true));

    this.panel = document.createElement("div");
    this.panel.className = "apb-panel";
    this.panel.style.display = "none";
    this.headerEl = document.createElement("div");
    this.headerEl.className = "apb-head";
    this.controlsEl = document.createElement("div");
    this.controlsEl.className = "apb-controls";
    this.bodyEl = document.createElement("div");
    this.bodyEl.className = "apb-body";
    this.panel.appendChild(this.headerEl);
    this.panel.appendChild(this.controlsEl);
    this.panel.appendChild(this.bodyEl);

    this.shadow.appendChild(this.pill);
    this.shadow.appendChild(this.panel);
    this.shadow.addEventListener("click", (event) => void this.onClick(event));
    this.shadow.addEventListener("input", (event) => this.onInput(event));
    this.shadow.addEventListener("change", (event) => this.onInput(event));
    document.documentElement.appendChild(this.host);

    this.renderHeader();
    this.renderControls();
  }

  destroy(): void {
    this.host.remove();
  }

  hasContent(): boolean {
    return this.groups.length > 0 || this.pending > 0;
  }

  /** Merge in the full deck list so the deck picker offers every deck. */
  setDecks(decks: string[]): void {
    this.decks = [...new Set([...decks, ...this.decks])];
    if (this.expanded) this.renderBody();
    this.renderControls();
  }

  /** Top-of-board control to send every card (existing and newly generated) to one deck. */
  private renderControls(): void {
    const deckList = [...new Set([this.bulkDeck, ...this.decks].filter(Boolean))].sort((a, b) =>
      a.localeCompare(b),
    );
    const options = [`<option value="">Routed deck (default)</option>`]
      .concat(
        deckList.map(
          (deck) => `<option value="${escapeHtml(deck)}"${deck === this.bulkDeck ? " selected" : ""}>${escapeHtml(deck)}</option>`,
        ),
      )
      .join("");
    this.controlsEl.innerHTML = `<label>Send all cards to</label><select data-bulk-deck>${options}</select>`;
  }

  private applyBulkDeck(): void {
    if (!this.bulkDeck) return;
    for (const group of this.groups) {
      for (const card of group.cards) card.deck = this.bulkDeck;
    }
    this.renderBody();
  }

  /** True when cards exist (or are being generated) that have not been added to Anki. */
  hasUnsaved(): boolean {
    return this.groups.length > 0 || this.pending > 0;
  }

  isExpanded(): boolean {
    return this.expanded;
  }

  setExpanded(value: boolean): void {
    this.expanded = value && this.hasContent();
    this.pill.style.display = this.expanded || !this.hasContent() ? "none" : "flex";
    this.panel.style.display = this.expanded ? "flex" : "none";
    if (this.expanded) this.renderBody();
    this.renderHeader();
  }

  incPending(): void {
    this.pending += 1;
    this.renderHeader();
    this.updatePill();
  }

  decPending(): void {
    this.pending = Math.max(0, this.pending - 1);
    this.renderHeader();
    this.updatePill();
  }

  addGroup(id: string, url: string, label: string, cards: RoutedCard[], note?: string): void {
    this.decks = [...new Set([...this.decks, ...cards.map((c) => c.deck).filter(Boolean)])];
    this.groups.push({
      id,
      url,
      label,
      note,
      adding: false,
      cards: cards.map((card) => ({
        kind: card.kind,
        text: card.text,
        backExtra: card.backExtra,
        deck: this.bulkDeck || card.deck,
        confidence: card.confidence,
        issues: card.issues ?? [],
        image: card.image,
        imageSide: card.imageSide,
        bothDirections: card.bothDirections,
        anchor: card.anchor,
      })),
    });
    this.renderHeader();
    this.renderBody();
    this.updatePill();
  }

  addError(id: string, label: string, message: string): void {
    this.errors.push({ id, label, message });
    this.renderHeader();
    this.renderBody();
    this.updatePill();
  }

  notify(message: string): void {
    this.statusMessage = message;
    this.renderHeader();
  }

  private hostOf(url: string): string {
    try {
      return new URL(url).host;
    } catch {
      return url.slice(0, 40);
    }
  }

  private updatePill(): void {
    if (this.expanded) {
      this.pill.style.display = "none";
      return;
    }
    const count = this.groups.reduce((sum, g) => sum + g.cards.length, 0);
    const show = count > 0 || this.pending > 0 || this.errors.length > 0;
    this.pill.style.display = show ? "flex" : "none";
    if (!show) return;
    const pendingHtml = this.pending > 0 ? `<span class="apb-spin"></span>` : "";
    this.pill.innerHTML = `${pendingHtml}<span>Review board</span><span class="apb-count">${count}</span>`;
  }

  private renderHeader(): void {
    const count = this.groups.reduce((sum, g) => sum + g.cards.length, 0);
    const sub = [
      `${count} card${count === 1 ? "" : "s"}`,
      this.pending > 0 ? `generating ${this.pending}…` : "",
      this.errors.length > 0 ? `${this.errors.length} error${this.errors.length === 1 ? "" : "s"}` : "",
      this.statusMessage,
    ]
      .filter(Boolean)
      .join(" · ");
    this.headerEl.innerHTML = `
      <span class="apb-title">Review board</span>
      <span class="apb-sub">${escapeHtml(sub)}</span>
      <button class="apb-btn" data-action="options" title="Settings">⚙</button>
      <button class="apb-btn danger" data-action="clear" ${this.groups.length || this.errors.length ? "" : "disabled"}>Clear</button>
      <button class="apb-btn primary" data-action="add-all" ${this.addingAll || this.groups.length === 0 ? "disabled" : ""}>Add all</button>
      <button class="apb-btn" data-action="collapse" title="Collapse">▾</button>`;
    this.updatePill();
  }

  private deckSelect(groupId: string, index: number, selected: string): string {
    const options = [...new Set([selected, ...this.decks].filter(Boolean))]
      .sort((a, b) => a.localeCompare(b))
      .map(
        (deck) =>
          `<option value="${escapeHtml(deck)}"${deck === selected ? " selected" : ""}>${escapeHtml(deck)}</option>`,
      )
      .join("");
    return `<div class="apb-deck-row"><label>Deck</label><select class="apb-input" data-field="deck" data-group="${groupId}" data-index="${index}">${options}</select></div>`;
  }

  private renderCard(group: BoardGroup, card: BoardCard, index: number): string {
    const badge = `<span class="apb-badge${card.confidence >= 0.75 ? "" : " low"}">${Math.round(card.confidence * 100)}%</span>`;
    const issues = card.issues.length
      ? `<div class="apb-issues">${card.issues.map((i) => `⚠ ${escapeHtml(i)}`).join(" · ")}</div>`
      : "";
    const del = `<button class="apb-del" data-action="delete-card" data-group="${group.id}" data-index="${index}">Remove</button>`;

    if (card.kind === "image") {
      const side = card.imageSide ?? "front";
      const both = card.bothDirections ?? true;
      return `
        <div class="apb-card">
          <div class="apb-card-top"><span class="apb-idx">Image card</span>${badge}${del}</div>
          <img class="apb-thumb" src="${escapeHtml(thumbSrc(card.image))}" alt="">
          <textarea class="apb-input" rows="2" data-field="text" data-group="${group.id}" data-index="${index}" placeholder="Answer text…">${escapeHtml(card.text)}</textarea>
          <div class="apb-deck-row"><label>Image side</label><select class="apb-input" data-field="imageSide" data-group="${group.id}" data-index="${index}">
            <option value="front"${side === "front" ? " selected" : ""}>Front</option>
            <option value="back"${side === "back" ? " selected" : ""}>Back</option>
          </select></div>
          <label class="apb-check"><input type="checkbox" data-field="bothDirections" data-group="${group.id}" data-index="${index}"${both ? " checked" : ""}> Both directions</label>
          ${this.deckSelect(group.id, index, card.deck)}
          ${issues}
        </div>`;
    }

    return `
      <div class="apb-card">
        <div class="apb-card-top"><span class="apb-idx">Card ${index + 1}</span>${badge}${del}</div>
        <textarea class="apb-input" rows="2" data-field="text" data-group="${group.id}" data-index="${index}" placeholder="Cloze text…">${escapeHtml(card.text)}</textarea>
        <textarea class="apb-input" rows="2" data-field="backExtra" data-group="${group.id}" data-index="${index}" placeholder="Optional context (source added automatically)">${escapeHtml(card.backExtra)}</textarea>
        ${this.deckSelect(group.id, index, card.deck)}
        ${issues}
      </div>`;
  }

  private renderGroup(group: BoardGroup): string {
    const note = group.note ? `<span class="apb-group-src">${escapeHtml(group.note)}</span>` : "";
    const error = group.error ? `<div class="apb-issues">⚠ ${escapeHtml(group.error)}</div>` : "";
    return `
      <div class="apb-group">
        <div class="apb-group-head">
          <span class="apb-group-label">${escapeHtml(group.label)}</span>
          <span class="apb-group-src">${escapeHtml(this.hostOf(group.url))}</span>
          <button class="apb-del" data-action="remove-group" data-group="${group.id}">Remove</button>
        </div>
        ${note}
        ${group.cards.map((card, i) => this.renderCard(group, card, i)).join("")}
        <div class="apb-card-top" style="margin-top:7px">
          ${group.cards.some((c) => c.kind === "image") ? "" : `<button class="apb-btn" data-action="add-card" data-group="${group.id}">+ Card</button>`}
          <div class="apb-spacer"></div>
          <button class="apb-btn" data-action="add-group" data-group="${group.id}" ${group.adding ? "disabled" : ""}>${group.adding ? "Adding…" : "Add these"}</button>
        </div>
        ${error}
      </div>`;
  }

  private renderBody(): void {
    const groupsHtml = this.groups.map((g) => this.renderGroup(g)).join("");
    const errorsHtml = this.errors
      .map(
        (e) => `<div class="apb-error">
          <div style="font-size:12px;font-weight:600;margin-bottom:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(e.label)}</div>
          <div style="color:#f2a1a1;font-size:11px">${escapeHtml(e.message)}</div>
          <div class="apb-card-top" style="margin-top:6px">
            <button class="apb-btn" data-action="retry" data-job="${e.id}">Retry</button>
            <button class="apb-btn danger" data-action="dismiss-error" data-job="${e.id}">Dismiss</button>
          </div></div>`,
      )
      .join("");
    const empty = !groupsHtml && !errorsHtml ? `<div class="apb-empty">Highlight text and press your shortcut — cards collect here until you're ready to review.</div>` : "";
    this.bodyEl.innerHTML = `${errorsHtml}${groupsHtml}${empty}
      <div class="apb-hint">All cards are editable here. Add them individually or all at once.</div>`;
    autosizeAll(this.bodyEl);
  }

  private onInput(event: Event): void {
    const target = event.target as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null;
    if (!target) return;
    if (target.dataset.bulkDeck !== undefined) {
      this.bulkDeck = (target as HTMLSelectElement).value;
      this.applyBulkDeck();
      return;
    }
    const group = this.groups.find((g) => g.id === target.dataset.group);
    const index = target.dataset.index !== undefined ? Number(target.dataset.index) : -1;
    const card = group?.cards[index];
    if (!card) return;
    const field = target.dataset.field;
    if (field === "text") card.text = target.value;
    else if (field === "backExtra") card.backExtra = target.value;
    else if (field === "deck") card.deck = target.value;
    else if (field === "imageSide") card.imageSide = target.value as ImageSide;
    else if (field === "bothDirections") card.bothDirections = (target as HTMLInputElement).checked;
    if (target instanceof HTMLTextAreaElement) autosize(target);
  }

  private collect(group: BoardGroup): FinalCard[] {
    return group.cards
      .filter((card) => card.kind === "image" || card.text.trim().length > 0)
      .map((card) => ({
        kind: card.kind,
        text: card.text.trim(),
        backExtra: card.backExtra.trim(),
        deck: card.deck || this.decks[0] || "",
        image: card.image,
        imageSide: card.imageSide,
        bothDirections: card.bothDirections,
        anchor: card.anchor,
      }));
  }

  private async submitGroup(group: BoardGroup): Promise<boolean> {
    const cards = this.collect(group);
    if (cards.length === 0) {
      group.error = "Nothing to add — no card has content.";
      this.renderBody();
      return false;
    }
    group.adding = true;
    group.error = undefined;
    this.renderBody();
    const result = await this.callbacks.onAdd(group.id, cards, group.url);
    if (result.ok) {
      this.groups = this.groups.filter((g) => g.id !== group.id);
      this.statusMessage = result.message ?? "Added.";
      this.renderHeader();
      this.renderBody();
      this.updatePill();
      return true;
    }
    group.adding = false;
    group.error = result.error ?? "Could not add cards.";
    this.renderBody();
    return false;
  }

  private async addAll(): Promise<void> {
    if (this.addingAll) return;
    this.addingAll = true;
    const total = this.groups.length;
    let added = 0;
    let queued = 0;
    for (let i = 0; i < this.groups.length; ) {
      const group = this.groups[i];
      this.statusMessage = `Adding ${i + 1}/${total}…`;
      this.renderHeader();
      const result = await this.callbacks.onAdd(group.id, this.collect(group), group.url);
      if (result.ok) {
        if (result.queued) queued += 1;
        else added += 1;
        this.groups = this.groups.filter((g) => g.id !== group.id);
      } else {
        group.adding = false;
        group.error = result.error ?? "Could not add.";
        i += 1; // keep it, move on
      }
      this.renderBody();
      this.updatePill();
    }
    this.addingAll = false;
    this.statusMessage = queued > 0 ? `Queued ${queued} group(s), added ${added}.` : `Added ${added} group(s).`;
    this.renderHeader();
    this.renderBody();
    if (!this.hasContent()) this.setExpanded(false);
  }

  private async onClick(event: Event): Promise<void> {
    const target = event.target as HTMLElement | null;
    const actionEl = target?.closest<HTMLElement>("[data-action]");
    if (!actionEl) return;
    const action = actionEl.dataset.action as string;
    const group = this.groups.find((g) => g.id === actionEl.dataset.group);
    const jobId = actionEl.dataset.job;
    const index = actionEl.dataset.index !== undefined ? Number(actionEl.dataset.index) : -1;

    switch (action) {
      case "collapse":
        this.setExpanded(false);
        break;
      case "options":
        this.callbacks.onOpenOptions();
        break;
      case "add-group":
        if (group) await this.submitGroup(group);
        break;
      case "add-all":
        await this.addAll();
        break;
      case "remove-group":
        if (group) {
          this.groups = this.groups.filter((g) => g.id !== group.id);
          this.renderHeader();
          this.renderBody();
          this.updatePill();
        }
        break;
      case "delete-card":
        if (group && index >= 0) {
          group.cards.splice(index, 1);
          if (group.cards.length === 0) this.groups = this.groups.filter((g) => g.id !== group.id);
          this.renderHeader();
          this.renderBody();
          this.updatePill();
        }
        break;
      case "add-card":
        if (group) {
          group.cards.push({
            text: "",
            backExtra: "",
            deck: group.cards[group.cards.length - 1]?.deck ?? this.decks[0] ?? "",
            confidence: 0,
            issues: [],
          });
          this.renderBody();
        }
        break;
      case "retry":
        if (jobId) {
          this.errors = this.errors.filter((e) => e.id !== jobId);
          this.renderBody();
          this.updatePill();
          this.callbacks.onRetry(jobId);
        }
        break;
      case "dismiss-error":
        if (jobId) {
          this.errors = this.errors.filter((e) => e.id !== jobId);
          this.renderBody();
          this.updatePill();
        }
        break;
      case "clear":
        this.groups = [];
        this.errors = [];
        this.statusMessage = "";
        this.renderHeader();
        this.renderBody();
        this.updatePill();
        break;
      default:
        break;
    }
  }
}
