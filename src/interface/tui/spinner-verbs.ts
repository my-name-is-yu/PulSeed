/**
 * Plant-themed spinner verbs — displayed while the AI is thinking.
 * Rotates through these like Claude Code's spinner messages.
 */

const SPINNER_VERBS: readonly string[] = [
  "Germinating",
  "Sprouting",
  "Rooting",
  "Budding",
  "Branching",
  "Flowering",
  "Pollinating",
  "Leafing",
  "Photosynthesizing",
  "Growing",
  "Blossoming",
  "Cultivating",
  "Unfurling",
  "Ripening",
  "Blooming",
  "Propagating",
  "Composting",
  "Watering",
  "Pruning",
  "Harvesting",
  "Seeding",
  "Mulching",
  "Grafting",
  "Transplanting",
];

/** Pick a random verb from the list */
export function pickSpinnerVerb(): string {
  return SPINNER_VERBS[Math.floor(Math.random() * SPINNER_VERBS.length)]!;
}

/** Total number of available verbs */
export const VERB_COUNT = SPINNER_VERBS.length;
