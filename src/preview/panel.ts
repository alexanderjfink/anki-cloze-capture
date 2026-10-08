import { escapeHtml } from "../lib/anki";
import { autosize, autosizeAll } from "./autosize";
import type { FinalCard, ImageRef, ImageSide, PageAnchor, RoutedCard } from "../lib/types";

export interface JobCallbacks {
  onAdd: (jobId: string, cards: FinalCard[], url: string) => void;
  onRegenerate: (jobId: string) => void;
  onOpenOptions: () => void;
}

type JobStatus = "generating" | "preview" | "adding" | "added" | "queued" | "error";

interface EditableCard {
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

export function thumbSrc(image?: ImageRef): string {
  if (!image) return "";
  if (image.dataBase64) return `data:${image.mime || "image/png"};base64,${image.dataBase64}`;
  return image.sourceUrl;
}

interface Job {
  id: string;
  url: string;
  label: string;
  status: JobStatus;
  editMode: boolean;
  note?: string;
  error?: string;
  summary?: string;
  cards: EditableCard[];
  decks: string[];
  fallbackDeck: string;
  timer?: ReturnType<typeof setTimeout>;
}

const MAX_VISIBLE_JOBS = 6;

const STYLES = `
:host { all: initial; }
.acp-stack {
  position: fixed; right: 18px; bottom: 18px; z-index: 2147483647;
  display: flex; flex-direction: column; gap: 10px; align-items: flex-end;
  max-height: 92vh; overflow-y: auto; pointer-events: none;
  font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
}
.acp-job {
  pointer-events: auto; width: 440px; max-width: calc(100vw - 32px);
  background: #1e1f24; color: #e7e7ea; border: 1px solid #3a3c45;
  border-radius: 12px; box-shadow: 0 12px 40px rgba(0,0,0,.45);
  display: flex; flex-direction: column; max-height: 70vh;
}
.acp-head { display:flex; align-items:center; gap:8px; padding:9px 11px; border-bottom:1px solid #3a3c45; }
.acp-title { font-weight:600; font-size:12px; flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.acp-pill { font-size:10px; padding:2px 7px; border-radius:999px; white-space:nowrap; }
.acp-pill.gen { background:#2b3a52; color:#a9c7ff; }
.acp-pill.preview { background:#3a3560; color:#cfc4ff; }
.acp-pill.adding { background:#2f5233; color:#a7ecb0; }
.acp-pill.added { background:#2f5233; color:#a7ecb0; }
.acp-pill.queued { background:#4a3a22; color:#f2c98a; }
.acp-pill.error { background:#5a2a2a; color:#f2a1a1; }
.acp-x { background:none; border:none; color:#8f95a3; cursor:pointer; font-size:13px; }
.acp-body { padding:9px 11px; overflow:auto; }
.acp-note { color:#8f95a3; font-size:11px; margin-bottom:6px; }
.acp-card { background:#26272e; border:1px solid #35363f; border-radius:9px; padding:8px 9px; margin-bottom:8px; }
.acp-card-top { display:flex; align-items:center; gap:8px; margin-bottom:6px; }
.acp-idx { font-size:11px; color:#9aa0ad; }
.acp-badge { font-size:10px; padding:2px 6px; border-radius:999px; background:#2f5233; color:#a7ecb0; }
.acp-badge.low { background:#4a3a22; color:#f2c98a; }
.acp-del { margin-left:auto; background:none; border:none; color:#e08a8a; cursor:pointer; font-size:11px; }
.acp-text { margin:2px 0 6px; word-break:break-word; }
.acp-cloze { background:#3a4a63; border-radius:4px; padding:0 3px; color:#cfe1ff; }
.acp-hint { color:#9aa0ad; font-size:11px; }
.acp-context { color:#a9aeb9; font-size:12px; border-left:2px solid #3a3c45; padding-left:8px; margin:4px 0; }
.acp-issues { color:#f2c98a; font-size:11px; margin-top:5px; }
textarea.acp-input, select.acp-input {
  width:100%; box-sizing:border-box; background:#1b1c21; color:#e7e7ea;
  border:1px solid #40424c; border-radius:6px; padding:6px 7px;
  font:12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; resize:vertical; margin-bottom:6px;
}
select.acp-input { font-family:inherit; }
.acp-deck-row { display:flex; align-items:center; gap:6px; margin-bottom:2px; min-width:0; }
.acp-deck-row label { font-size:11px; color:#9aa0ad; flex:0 0 auto; }
.acp-deck-row select { min-width:0; }
.acp-foot { display:flex; gap:7px; padding:9px 11px; border-top:1px solid #3a3c45; }
.acp-btn { border:1px solid #454754; background:#2c2d35; color:#e7e7ea; border-radius:7px; padding:5px 10px; cursor:pointer; font-size:12px; }
.acp-btn:hover { background:#35363f; }
.acp-btn.primary { background:#3b6fd4; border-color:#3b6fd4; color:#fff; }
.acp-btn.primary:hover { background:#4a7ee0; }
.acp-btn.ghost { background:transparent; }
.acp-btn:disabled { opacity:.55; cursor:default; }
.acp-spacer { flex:1; }
.acp-loading { display:flex; align-items:center; gap:10px; padding:12px 2px; color:#cbd0da; }
.acp-spinner { width:15px; height:15px; border:2px solid #4a4c58; border-top-color:#7aa2f7; border-radius:50%; animation:acp-spin .8s linear infinite; }
@keyframes acp-spin { to { transform:rotate(360deg); } }
.acp-error { color:#f2a1a1; padding:4px 0; }
.acp-hintline { color:#8f95a3; font-size:11px; padding:0 11px 7px; }
.acp-thumb { max-width:100%; max-height:220px; border-radius:7px; margin-bottom:6px; display:block; background:#111; }
.acp-check { display:flex; align-items:center; gap:6px; font-size:11px; color:#9aa0ad; margin-bottom:5px; }
`;

export class JobPanel {
  private host: HTMLDivElement;
  private shadow: ShadowRoot;
  private stack: HTMLDivElement;
  private nodeById = new Map<string, HTMLDivElement>();
  private jobs: Job[] = [];
  private allDecks: string[] = [];
  private callbacks: JobCallbacks;

  constructor(callbacks: JobCallbacks) {
    this.callbacks = callbacks;
    this.host = document.createElement("div");
    this.host.style.cssText = "all:initial;";
    this.shadow = this.host.attachShadow({ mode: "open" });
    this.shadow.innerHTML = `<style>${STYLES}</style>`;
    this.stack = document.createElement("div");
    this.stack.className = "acp-stack";
    this.shadow.appendChild(this.stack);
    this.shadow.addEventListener("click", (event) => this.onClick(event));
    this.shadow.addEventListener("input", (event) => this.onInput(event));
    this.shadow.addEventListener("change", (event) => this.onInput(event));
    document.documentElement.appendChild(this.host);
  }

  destroy(): void {
    this.jobs.forEach((job) => job.timer && clearTimeout(job.timer));
    this.host.remove();
  }

  isOpen(): boolean {
    return this.jobs.length > 0;
  }

  hasJobs(): boolean {
    return this.jobs.length > 0;
  }

  /** Merge in the full deck list so the deck picker offers every deck. */
  setDecks(decks: string[]): void {
    this.allDecks = [...new Set([...decks, ...this.allDecks])];
    for (const job of this.jobs) this.renderJob(job);
  }

  /** True when cards exist (or are being generated) that have not been added to Anki. */
  hasUnsaved(): boolean {
    return this.jobs.some(
      (job) => job.status === "generating" || job.status === "preview" || job.status === "adding",
    );
  }

  private job(id: string): Job | undefined {
    return this.jobs.find((j) => j.id === id);
  }

  addJob(id: string, url: string, label: string): void {
    const job: Job = {
      id,
      url,
      label,
      status: "generating",
      editMode: false,
      cards: [],
      decks: [],
      fallbackDeck: "",
    };
    this.jobs.push(job);
    this.prune();
    this.renderJob(job);
  }

  setGenerating(id: string, note?: string): void {
    const job = this.job(id);
    if (!job) return;
    job.status = "generating";
    job.note = note;
    job.error = undefined;
    this.renderJob(job);
  }

  setPreview(id: string, cards: RoutedCard[], decks: string[], fallbackDeck: string, note?: string): void {
    const job = this.job(id);
    if (!job) return;
    job.status = "preview";
    job.note = note;
    job.editMode = false;
    job.decks = decks;
    job.fallbackDeck = fallbackDeck;
    job.cards = cards.map((card) => ({
      kind: card.kind,
      text: card.text,
      backExtra: card.backExtra,
      deck: card.deck,
      confidence: card.confidence,
      issues: card.issues ?? [],
      image: card.image,
      imageSide: card.imageSide,
      bothDirections: card.bothDirections,
      anchor: card.anchor,
    }));
    this.renderJob(job);
  }

  setError(id: string, message: string): void {
    const job = this.job(id);
    if (!job) return;
    job.status = "error";
    job.error = message;
    this.renderJob(job);
  }

  setAdding(id: string): void {
    const job = this.job(id);
    if (!job) return;
    job.status = "adding";
    this.renderJob(job);
  }

  setResult(id: string, kind: "added" | "queued", summary: string): void {
    const job = this.job(id);
    if (!job) return;
    job.status = kind;
    job.summary = summary;
    this.renderJob(job);
    job.timer = setTimeout(() => this.removeJob(id), 9000);
  }

  toggleEdit(id: string): void {
    const job = this.job(id);
    if (!job || job.status !== "preview") return;
    job.editMode = !job.editMode;
    this.renderJob(job);
  }

  toggleLatestEdit(): void {
    const job = [...this.jobs].reverse().find((j) => j.status === "preview");
    if (job) this.toggleEdit(job.id);
  }

  removeJob(id: string): void {
    const job = this.job(id);
    if (job?.timer) clearTimeout(job.timer);
    this.jobs = this.jobs.filter((j) => j.id !== id);
    this.nodeById.get(id)?.remove();
    this.nodeById.delete(id);
  }

  /** Remove the newest job (used by Escape). */
  dismissNewest(): boolean {
    const job = this.jobs[this.jobs.length - 1];
    if (!job) return false;
    this.removeJob(job.id);
    return true;
  }

  private prune(): void {
    const completed = this.jobs.filter((j) => j.status === "added" || j.status === "queued");
    while (this.jobs.length > MAX_VISIBLE_JOBS && completed.length > 0) {
      const victim = completed.shift();
      if (victim) this.removeJob(victim.id);
    }
  }

  private onClick(event: Event): void {
    const target = event.target as HTMLElement | null;
    const actionEl = target?.closest<HTMLElement>("[data-action]");
    if (!actionEl) return;
    const action = actionEl.dataset.action as string;
    const id = actionEl.dataset.job as string;
    const job = this.job(id);
    if (action === "close") {
      this.removeJob(id);
      return;
    }
    if (!job) return;
    const index = actionEl.dataset.index !== undefined ? Number(actionEl.dataset.index) : -1;

    switch (action) {
      case "edit-toggle":
        this.toggleEdit(id);
        break;
      case "done-edit":
        job.editMode = false;
        this.renderJob(job);
        break;
      case "regenerate":
        this.callbacks.onRegenerate(id);
        break;
      case "add":
        this.submit(job);
        break;
      case "delete":
        if (index >= 0) {
          job.cards.splice(index, 1);
          this.renderJob(job);
        }
        break;
      case "add-card":
        job.cards.push({
          text: "",
          backExtra: "",
          deck: job.cards[job.cards.length - 1]?.deck ?? job.decks[0] ?? job.fallbackDeck,
          confidence: 0,
          issues: [],
        });
        job.editMode = true;
        this.renderJob(job);
        break;
      case "options":
        this.callbacks.onOpenOptions();
        break;
      default:
        break;
    }
  }

  private onInput(event: Event): void {
    const target = event.target as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null;
    if (!target) return;
    const id = target.dataset.job;
    const field = target.dataset.field;
    const index = target.dataset.index !== undefined ? Number(target.dataset.index) : -1;
    if (!id || !field) return;
    const job = this.job(id);
    const card = job?.cards[index];
    if (!card) return;
    if (field === "text") card.text = target.value;
    else if (field === "backExtra") card.backExtra = target.value;
    else if (field === "deck") card.deck = target.value;
    else if (field === "imageSide") card.imageSide = target.value as ImageSide;
    else if (field === "bothDirections") card.bothDirections = (target as HTMLInputElement).checked;
    if (target instanceof HTMLTextAreaElement) autosize(target);
  }

  private submit(job: Job): void {
    const valid = job.cards
      .filter((card) => card.kind === "image" || card.text.trim().length > 0)
      .map<FinalCard>((card) => ({
        kind: card.kind,
        text: card.text.trim(),
        backExtra: card.backExtra.trim(),
        deck: card.deck || job.decks[0] || job.fallbackDeck,
        image: card.image,
        imageSide: card.imageSide,
        bothDirections: card.bothDirections,
        anchor: card.anchor,
      }));
    if (valid.length === 0) {
      job.error = "Nothing to add — no card has content.";
      this.renderJob(job);
      return;
    }
    this.callbacks.onAdd(job.id, valid, job.url);
  }

  private confidenceClass(confidence: number): string {
    return confidence >= 0.75 ? "acp-badge" : "acp-badge low";
  }

  private renderClozeHtml(text: string): string {
    return escapeHtml(text).replace(/\{\{c(\d+)::([\s\S]*?)\}\}/g, (_m, _n, inner: string) => {
      const [answer, hint] = inner.split("::");
      const hintHtml = hint ? ` <span class="acp-hint">(${escapeHtml(hint)})</span>` : "";
      return `<span class="acp-cloze">${answer}</span>${hintHtml}`;
    });
  }

  private deckSelect(job: Job, index: number, selected: string): string {
    const options = [...new Set([selected, ...this.allDecks, ...job.decks].filter(Boolean))]
      .sort((a, b) => a.localeCompare(b))
      .map(
        (deck) =>
          `<option value="${escapeHtml(deck)}"${deck === selected ? " selected" : ""}>${escapeHtml(deck)}</option>`,
      )
      .join("");
    return `<div class="acp-deck-row"><label>Deck</label><select class="acp-input" data-field="deck" data-job="${job.id}" data-index="${index}">${options}</select></div>`;
  }

  private renderCard(job: Job, card: EditableCard, index: number): string {
    if (card.kind === "image") return this.renderImageCard(job, card, index);
    const badge = `<span class="${this.confidenceClass(card.confidence)}">${Math.round(card.confidence * 100)}%</span>`;
    const issues = card.issues.length
      ? `<div class="acp-issues">${card.issues.map((i) => `<div>⚠ ${escapeHtml(i)}</div>`).join("")}</div>`
      : "";

    if (job.editMode) {
      return `
        <div class="acp-card">
          <div class="acp-card-top"><span class="acp-idx">Card ${index + 1}</span>${badge}<button class="acp-del" data-action="delete" data-job="${job.id}" data-index="${index}">Remove</button></div>
          <textarea class="acp-input" rows="3" data-field="text" data-job="${job.id}" data-index="${index}" placeholder="Cloze text…">${escapeHtml(card.text)}</textarea>
          <textarea class="acp-input" rows="2" data-field="backExtra" data-job="${job.id}" data-index="${index}" placeholder="Optional context (source added automatically)">${escapeHtml(card.backExtra)}</textarea>
          ${this.deckSelect(job, index, card.deck)}
          ${issues}
        </div>`;
    }

    const context = card.backExtra ? `<div class="acp-context">${escapeHtml(card.backExtra)}</div>` : "";
    return `
      <div class="acp-card">
        <div class="acp-card-top"><span class="acp-idx">Card ${index + 1}</span>${badge}<button class="acp-del" data-action="delete" data-job="${job.id}" data-index="${index}">Remove</button></div>
        <div class="acp-text">${this.renderClozeHtml(card.text)}</div>
        ${context}
        <div class="acp-deck-row"><label>Deck</label><strong>${escapeHtml(card.deck || "(none)")}</strong></div>
        ${issues}
      </div>`;
  }

  private renderImageCard(job: Job, card: EditableCard, index: number): string {
    const badge = `<span class="${this.confidenceClass(card.confidence)}">${Math.round(card.confidence * 100)}%</span>`;
    const issues = card.issues.length
      ? `<div class="acp-issues">${card.issues.map((i) => `<div>⚠ ${escapeHtml(i)}</div>`).join("")}</div>`
      : "";
    const thumb = escapeHtml(thumbSrc(card.image));
    const side = card.imageSide ?? "front";
    const both = card.bothDirections ?? true;
    const del = `<button class="acp-del" data-action="delete" data-job="${job.id}" data-index="${index}">Remove</button>`;

    if (job.editMode) {
      return `
        <div class="acp-card">
          <div class="acp-card-top"><span class="acp-idx">Image card</span>${badge}${del}</div>
          <img class="acp-thumb" src="${thumb}" alt="">
          <textarea class="acp-input" rows="2" data-field="text" data-job="${job.id}" data-index="${index}" placeholder="Answer text…">${escapeHtml(card.text)}</textarea>
          <div class="acp-deck-row"><label>Image side</label><select class="acp-input" data-field="imageSide" data-job="${job.id}" data-index="${index}">
            <option value="front"${side === "front" ? " selected" : ""}>Front</option>
            <option value="back"${side === "back" ? " selected" : ""}>Back</option>
          </select></div>
          <label class="acp-check"><input type="checkbox" data-field="bothDirections" data-job="${job.id}" data-index="${index}"${both ? " checked" : ""}> Both directions</label>
          ${this.deckSelect(job, index, card.deck)}
          ${issues}
        </div>`;
    }

    return `
      <div class="acp-card">
        <div class="acp-card-top"><span class="acp-idx">Image card</span>${badge}${del}</div>
        <img class="acp-thumb" src="${thumb}" alt="">
        <div class="acp-text">${escapeHtml(card.text)}</div>
        <div class="acp-deck-row"><label>Image</label><strong>${side} · ${both ? "both directions" : "one direction"}</strong></div>
        ${issues}
      </div>`;
  }

  private head(job: Job, pillClass: string, pillText: string): string {    return `<div class="acp-head"><span class="acp-title">${escapeHtml(job.label)}</span><span class="acp-pill ${pillClass}">${pillText}</span><button class="acp-x" data-action="close" data-job="${job.id}" title="Dismiss">✕</button></div>`;
  }

  private body(job: Job): string {
    const noteHtml = job.note ? `<div class="acp-note">${escapeHtml(job.note)}</div>` : "";

    if (job.status === "generating") {
      return `<div class="acp-body">${noteHtml}<div class="acp-loading"><div class="acp-spinner"></div><div>Generating cards…</div></div></div>`;
    }
    if (job.status === "error") {
      return `<div class="acp-body"><div class="acp-error">${escapeHtml(job.error ?? "Something went wrong.")}</div></div>
        <div class="acp-foot"><button class="acp-btn" data-action="regenerate" data-job="${job.id}">Retry</button><button class="acp-btn ghost" data-action="options" data-job="${job.id}">Settings</button><div class="acp-spacer"></div><button class="acp-btn ghost" data-action="close" data-job="${job.id}">Dismiss</button></div>`;
    }
    if (job.status === "added" || job.status === "queued") {
      return `<div class="acp-body"><div class="acp-note">${noteHtml}</div><div style="font-size:13px">${escapeHtml(job.summary ?? "")}</div></div>
        <div class="acp-foot"><div class="acp-spacer"></div><button class="acp-btn" data-action="close" data-job="${job.id}">Done</button></div>`;
    }
    if (job.status === "adding") {
      return `<div class="acp-body">${noteHtml}<div class="acp-loading"><div class="acp-spinner"></div><div>Adding to Anki…</div></div></div>`;
    }
    // preview
    return `<div class="acp-body">${noteHtml}${job.cards.map((c, i) => this.renderCard(job, c, i)).join("")}
        ${job.error ? `<div class="acp-issues">${escapeHtml(job.error)}</div>` : ""}</div>
      <div class="acp-hintline">Alt+Shift+E toggles editing · Esc dismisses newest</div>
      <div class="acp-foot">${job.cards.some((c) => c.kind === "image") ? "" : `<button class="acp-btn" data-action="add-card" data-job="${job.id}">+ Card</button>`}
        <button class="acp-btn" data-action="${job.editMode ? "done-edit" : "edit-toggle"}" data-job="${job.id}">${job.editMode ? "Done" : "Edit"}</button>
        <div class="acp-spacer"></div>
        <button class="acp-btn ghost" data-action="close" data-job="${job.id}">Cancel</button>
        <button class="acp-btn primary" data-action="add" data-job="${job.id}">Add to Anki</button></div>`;
  }

  private renderJob(job: Job): void {
    let node = this.nodeById.get(job.id);
    if (!node) {
      node = document.createElement("div");
      node.className = "acp-job";
      this.nodeById.set(job.id, node);
      this.stack.appendChild(node);
    }
    const pill: Record<JobStatus, [string, string]> = {
      generating: ["gen", "generating"],
      preview: ["preview", "ready"],
      adding: ["adding", "adding"],
      added: ["added", "added"],
      queued: ["queued", "queued"],
      error: ["error", "error"],
    };
    const [cls, text] = pill[job.status];
    node.innerHTML = `${this.head(job, cls, text)}${this.body(job)}`;
    autosizeAll(node);
  }
}
