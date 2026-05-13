import {
  CharacterConfigSchema,
  type CharacterConfig,
} from "./types/character.js";

export function getCharacterFeasibilityThresholdHint(characterConfig: CharacterConfig): number {
  const parsed = CharacterConfigSchema.parse(characterConfig);
  return 1.5 + parsed.caution_level * 0.5;
}

export function getCharacterStallThresholdMultiplierHint(characterConfig: CharacterConfig): number {
  const parsed = CharacterConfigSchema.parse(characterConfig);
  return 0.75 + parsed.stall_flexibility * 0.25;
}
