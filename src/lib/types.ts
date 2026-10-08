// Shared types for Anki Cloze Capture.

export type ChatProviderKind = "opencode-go" | "ollama" | "vllm";
export type EmbeddingProviderKind = "ollama" | "vllm" | "custom";
export type BloomLevel =
  | "remember"
  | "understand"
  | "apply"
  | "analyze"
  | "evaluate"
  | "create"
  | "mix";

/** Reasoning effort for reasoning-capable models (sent only to OpenCode Go). */
export type ReasoningEffort = "default" | "none" | "minimal" | "low" | "medium" | "high";

export interface ChatProviderConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
}

export interface EmbeddingConfig {
  kind: EmbeddingProviderKind;
  baseUrl: string;
  model: string;
  apiKey: string;
}

export interface RoutingSettings {
  /** Minimum cosine similarity to accept the top deck; below this we use the fallback. */
  threshold: number;
  /** Deck used when no deck clears the threshold. */
  fallbackDeck: string;
  /** Decks never considered for routing. "Default" is always excluded on top of this. */
  exclusions: string[];
  /** Optional free-text description per deck, used to enrich its embedding. */
  deckDescriptions: Record<string, string>;
}

export interface CardSettings {
  maxCards: number;
  bloomLevel: BloomLevel;
  temperature: number;
  /** Max words allowed inside a single cloze deletion. */
  maxClozeWords: number;
  reasoningEffort: ReasoningEffort;
}

export interface ContextSettings {
  paragraphsBefore: number;
  paragraphsAfter: number;
}

export interface AnkiSettings {
  endpoint: string;
  noteModel: string;
  textField: string;
  backExtraField: string;
}

export interface TriggerSettings {
  floatingButton: boolean;
  allowContextInBackExtra: boolean;
  /** Warn before closing/reloading a tab that still has unsaved cards. */
  warnOnUnload: boolean;
}

export type CardKind = "cloze" | "image";
export type ImageSide = "front" | "back";

/** A reference to an image used by an image card. */
export interface ImageRef {
  sourceUrl: string;
  mime: string;
  /** Set once the file exists in Anki's media collection. */
  filename?: string;
  /** Base64 bytes, kept for preview, add, and offline queue. */
  dataBase64?: string;
  width?: number;
  height?: number;
  alt?: string;
}

export interface ImageSettings {
  enabled: boolean;
  /** Model used when both directions are wanted (has reversal). */
  noteModel: string;
  /** Model used when only one direction is wanted. */
  oneWayModel: string;
  frontField: string;
  backField: string;
  defaultImageSide: ImageSide;
  defaultBothDirections: boolean;
  /** Per-image size cap in megabytes. */
  maxImageMB: number;
  /** Optional best-effort re-encode before storing. */
  downscale: boolean;
  maxDimension: number;
  /** Use a vision LLM to name the image (falls back to page context). */
  visionIdentifier: boolean;
}

/** immediate = a notification card per highlight; collect = one ongoing review board. */
export type CardFlowMode = "immediate" | "collect";

export interface FlowSettings {
  mode: CardFlowMode;
}

export interface ShortcutSettings {
  capture: string;
  edit: string;
  toggleMarkers: string;
  autogen: string;
}

export interface AutogenSettings {
  /** Default number of cards when autogenerating from a whole page. */
  defaultCount: number;
}

export interface AnchorSettings {
  showMarkers: boolean;
  /** Ignore #hash and common tracking params when matching a page URL. */
  normalizedUrls: boolean;
}

export type HypothesisMode = "off" | "api" | "dom" | "both";

export interface HypothesisSettings {
  mode: HypothesisMode;
  /** Personal Hypothes.is API token (hypothes.is/account/developer). */
  apiToken: string;
  pollSeconds: number;
  /** Include the annotation's note/comment text as Back Extra context. */
  includeNoteText: boolean;
}

/** A Hypothes.is highlight reduced to what the plugin needs. */
export interface HypothesisAnnotation {
  id: string;
  exact: string;
  prefix: string;
  suffix: string;
  noteText: string;
  url: string;
  created: string;
}

/** A resilient pointer back to the place on the page a card came from. */
export interface PageAnchor {
  kind: "text" | "image";
  quote: string;
  prefix: string;
  suffix: string;
  path?: string;
  offset?: number;
  imageSrc?: string;
}

export interface Annotation {
  id: string;
  url: string;
  urlKey: string;
  title: string;
  createdAt: number;
  noteIds: number[];
  cardKind: "cloze" | "image";
  deck: string;
  preview: string;
  anchor: PageAnchor;
}

export interface AnkiNoteInfo {
  noteId: number;
  modelName: string;
  fields: Record<string, string>;
  cards: number[];
}

/** How to pick between remote and local LLM providers for each request. */
export type ChargingOverride = "auto" | "charging" | "battery";

export interface ProviderStrategySettings {
  /** Prefer the local provider by default to save remote tokens/cost. */
  preferLocal: boolean;
  /** When preferring local, only use it while on AC power (saves battery). */
  localOnlyWhenCharging: boolean;
  /** If the chosen provider is unreachable (e.g. no wifi), retry on the local provider. */
  fallbackToLocalWhenOffline: boolean;
  /** Which local provider to use for the strategy. */
  localProvider: "ollama" | "vllm";
  /** Firefox has no battery API; "auto" uses it when present, otherwise treat as battery. */
  chargingOverride: ChargingOverride;
  /** Maximum card-generation requests processed at once. */
  maxConcurrentRequests: number;
}

export interface Settings {
  activeProvider: ChatProviderKind;
  providers: Record<ChatProviderKind, ChatProviderConfig>;
  providerStrategy: ProviderStrategySettings;
  embeddings: EmbeddingConfig;
  routing: RoutingSettings;
  cards: CardSettings;
  context: ContextSettings;
  anki: AnkiSettings;
  triggers: TriggerSettings;
  flow: FlowSettings;
  shortcuts: ShortcutSettings;
  images: ImageSettings;
  annotations: AnchorSettings;
  hypothesis: HypothesisSettings;
  autogen: AutogenSettings;
  queuePollSeconds: number;
}

/** A card before routing: cloze or image. */
export interface GeneratedCard {
  kind?: CardKind;
  text: string;
  backExtra: string;
  /** Verbatim source sentence from the page, used to anchor autogenerated cards. */
  sourceQuote?: string;
  image?: ImageRef;
  imageSide?: ImageSide;
  bothDirections?: boolean;
  /** Per-card page anchor (used for autogenerated cards). */
  anchor?: PageAnchor;
}

/** A generated card after deck routing. */
export interface RoutedCard extends GeneratedCard {
  deck: string;
  confidence: number;
  issues?: string[];
}

/** What the preview editor sends back to be committed. */
export interface FinalCard {
  kind?: CardKind;
  text: string;
  backExtra: string;
  deck: string;
  image?: ImageRef;
  imageSide?: ImageSide;
  bothDirections?: boolean;
  anchor?: PageAnchor;
}
export interface CapturePayload {
  selection: string;
  context: string;
  title: string;
  url: string;
  /** Optional annotation note text (e.g. from Hypothes.is) to fold into Back Extra. */
  noteText?: string;
  /** Whole-page autogeneration: pick the most useful facts. */
  autoGen?: boolean;
  /** Requested card count for autogeneration. */
  count?: number;
}

/** A captured image and its surrounding context. */
export interface ImageCaptureData {
  srcUrl: string;
  alt: string;
  caption: string;
  context: string;
  title: string;
  url: string;
  width?: number;
  height?: number;
  /** Present when the content script already resolved bytes (e.g. blob: URLs). */
  dataBase64?: string;
  mime?: string;
}

export interface QueueItem {
  id: string;
  createdAt: number;
  cards: FinalCard[];
  url: string;
  title?: string;
  anchor?: PageAnchor;
}

export interface RecentBatch {
  id: string;
  createdAt: number;
  noteIds: number[];
  deck: string;
  count: number;
  url: string;
}

export interface DeckMatch {
  deck: string;
  confidence: number;
}

// Message protocol between content script and background.
export type Message =
  | { type: "GENERATE_REQUEST"; jobId: string; payload: CapturePayload }
  | { type: "GENERATE_IMAGE_REQUEST"; jobId: string; payload: ImageCaptureData }
  | { type: "START_CAPTURE" }
  | { type: "START_IMAGE_CAPTURE"; srcUrl?: string }
  | { type: "START_HYPOTHESIS_IMPORT" }
  | { type: "START_AUTOGEN" }
  | { type: "TOGGLE_EDIT" }
  | { type: "SHOW_LOADING"; jobId: string; note?: string }
  | { type: "SHOW_ERROR"; jobId: string; message: string }
  | { type: "SHOW_PREVIEW"; jobId: string; cards: RoutedCard[]; decks: string[]; fallbackDeck: string; note?: string }
  | { type: "ADD_CARDS"; jobId: string; cards: FinalCard[]; url: string; title?: string; anchor?: PageAnchor }
  | { type: "ADD_RESULT"; jobId?: string; ok: boolean; added: number; skipped: number; failed: number; queued: boolean; message?: string; noteIds?: number[] }
  | { type: "GET_DECKS" }
  | { type: "DECKS"; decks: string[]; fallbackDeck: string }
  | { type: "OPEN_OPTIONS" }
  | { type: "GET_ANNOTATIONS"; url: string }
  | { type: "ANNOTATIONS"; annotations: Annotation[] }
  | { type: "GET_NOTE_DETAILS"; noteIds: number[] }
  | { type: "NOTE_DETAILS"; notes: AnkiNoteInfo[]; error?: string }
  | { type: "UPDATE_NOTE"; noteId: number; fields: Record<string, string> }
  | { type: "REMOVE_ANNOTATION"; id: string; url: string }
  | { type: "REBUILD_ANNOTATIONS"; url: string }
  | { type: "HYPOTHESIS_POLL"; url: string; importAll?: boolean }
  | { type: "HYPOTHESIS_TEST" }
  | { type: "HYPOTHESIS_CLEAR" }
  | { type: "FLUSH_QUEUE" }
  | { type: "CLEAR_QUEUE" }
  | { type: "GET_RECENT" }
  | { type: "UNDO_BATCH"; id: string }
  | { type: "REBUILD_INDEX" }
  | { type: "INDEX_RESULT"; ok: boolean; count: number; message?: string }
  | { type: "PING" }
  | { type: "PONG"; anki: boolean; provider: ChatProviderKind; model: string; effectiveProvider?: ChatProviderKind; strategyNote?: string };

export interface MessageResponse {
  ok: boolean;
  error?: string;
  [key: string]: unknown;
}
