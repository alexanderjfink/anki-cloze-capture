import type { BloomLevel, CapturePayload, Settings } from "./types";

const BLOOM_INSTRUCTIONS: Record<BloomLevel, string> = {
  remember:
    "Generate cloze cards that test recall of facts, definitions, dates, names, and specific details. Hide 1-2 words per cloze.",
  understand:
    "Generate cloze cards that test comprehension of relationships, causes, and explanations. Cards should require understanding why, not just what.",
  apply:
    "Generate scenario-based cloze cards that test the ability to use the concept in a new situation. Present a brief scenario and hide the correct application.",
  analyze:
    "Generate comparative or breakdown cloze cards. Contrast ideas, compare approaches, or identify components of the system being described.",
  evaluate:
    "Generate significance-based cloze cards: why something matters, its impact, or how it changed things. Focus on judgment and weighing evidence.",
  create:
    "Generate hypothesis or synthesis cloze cards. Present counterfactuals, design scenarios, or ask what would happen if key variables changed.",
  mix:
    "Generate a balanced mix: about 40% remember, 30% understand, 20% apply, and 10% analyze. Target the most important concepts.",
};

const CLOZE_RULES = [
  "Hide only 1-2 words per cloze deletion (2 words is the hard maximum). Never hide a whole phrase, clause, or sentence.",
  "If an answer needs more than 2 words, either hide the single most important word, or split it into separate clozes, or do not make a card for it.",
  "Hide the most meaningful key word (a noun, name, number, or technical term), never a filler or function word like 'most', 'very', 'the', or 'is'.",
  "Each cloze tests exactly ONE discrete fact.",
  "Use at most 3 cloze deletions per card.",
  "Add a hint with {{cN::answer::category}} only when the expected category is not obvious. Hints describe the category, never restate the answer.",
  "For multi-item sequences use HTML lists: <ul><li>S{{c1::olid}}</li><li>E{{c2::qualized}}</li></ul>.",
  "Preserve emphasis with <b> and <i> when it aids scanning.",
  "The card must stand alone: include enough context that it is unambiguous months later.",
  "Do not put the answer elsewhere in the sentence (no answer giveaway).",
  "No tags.",
];

const QUALITY_CHECKLIST = [
  "Targeting: does the card capture the specific insight worth remembering?",
  "Ambiguity: could you answer correctly but with different wording in 6 months?",
  "Context: is it grounded in a specific source, author, or concept?",
  "Novelty: does it preserve what was striking or interesting?",
  "Concision: can it be read in under 5 seconds?",
  "Answer-giveaway: does the non-cloze text reveal the answer?",
];

export function buildSystemPrompt(settings: Settings, autoGen = false): string {
  const level = settings.cards.bloomLevel;
  const schema = autoGen
    ? '{"cards":[{"text":"The {{c1::hidden::hint}} text.","backExtra":"Optional context.","source":"exact verbatim sentence from the page"}]}'
    : '{"cards":[{"text":"The {{c1::hidden::hint}} text.","backExtra":"Optional one or two sentences of extra context."}]}';
  const sourceRule = autoGen
    ? ["", "For every card, include a `source` field containing the EXACT, verbatim sentence copied from the page content that the card is based on (do not paraphrase it). This is required so the card can be linked back to the page."]
    : [];
  return [
    "You are an expert Anki card author. You convert text into high-quality cloze deletion cards.",
    "",
    "The single most important rule: a cloze deletion hides AT MOST 2 WORDS. If you are tempted to hide a longer phrase, hide the key word instead.",
    "",
    "Rules for every cloze card:",
    ...CLOZE_RULES.map((r) => `- ${r}`),
    "",
    `Cognitive level: ${BLOOM_INSTRUCTIONS[level]}`,
    "",
    "Before returning a card, silently apply this checklist and discard any card that fails:",
    ...QUALITY_CHECKLIST.map((q) => `- ${q}`),
    "",
    `Produce between 1 and ${settings.cards.maxCards} cards, choosing the number that best covers the material. Prefer fewer, sharper cards.`,
    ...sourceRule,
    "",
    "The user's selection is the passage to convert. Surrounding paragraphs are provided as context only.",
    "",
    "Return ONLY a JSON object with this exact shape, no markdown fences and no commentary:",
    schema,
    "",
    "The backExtra field is optional context for the answer side. NEVER include a source, URL, or the word Source in backExtra; the extension appends the source automatically.",
  ].join("\n");
}

export function buildUserPrompt(payload: CapturePayload): string {
  if (payload.autoGen) {
    return [
      `Page title: ${payload.title || "(untitled)"}`,
      `Page URL: ${payload.url || "(unknown)"}`,
      "",
      "Page content:",
      payload.selection,
      "",
      `From the page above, choose the ${payload.count ?? "most"} most useful, high-value facts and turn each into a cloze card. Skip navigation, boilerplate, ads, and low-value trivia. Prefer concepts that are worth remembering long-term.`,
    ].join("\n");
  }
  return [
    `Page title: ${payload.title || "(untitled)"}`,
    `Page URL: ${payload.url || "(unknown)"}`,
    "",
    "Surrounding context (do not convert this to cards):",
    payload.context || "(none)",
    "",
    "Passage to convert (convert this):",
    payload.selection,
  ].join("\n");
}

export function buildMessages(settings: Settings, payload: CapturePayload) {
  return [
    { role: "system" as const, content: buildSystemPrompt(settings, Boolean(payload.autoGen)) },
    { role: "user" as const, content: buildUserPrompt(payload) },
  ];
}
