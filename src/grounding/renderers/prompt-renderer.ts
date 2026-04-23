import type { GroundingBundle, GroundingSection, GroundingSectionKey } from "../contracts.js";
import { sortSections } from "../providers/helpers.js";

export interface PromptSectionRenderOptions {
  omitHeadingKeys?: readonly GroundingSectionKey[];
  titleOverrides?: Partial<Record<GroundingSectionKey, string>>;
  preserveOrder?: boolean;
}

function renderSection(section: GroundingSection, options: PromptSectionRenderOptions): string {
  if (options.omitHeadingKeys?.includes(section.key)) {
    return section.content.trim();
  }
  const title = options.titleOverrides?.[section.key] ?? section.title;
  return `## ${title}\n${section.content}`.trim();
}

export function pickGroundingSections<T extends GroundingSection>(
  sections: readonly T[],
  keys: readonly GroundingSectionKey[],
): T[] {
  const wanted = new Set(keys);
  return sections.filter((section) => wanted.has(section.key));
}

export function renderPromptSections(
  sections: readonly GroundingSection[],
  options: PromptSectionRenderOptions = {},
): string {
  const ordered = options.preserveOrder ? [...sections] : sortSections([...sections]);
  return ordered
    .map((section) => renderSection(section, options))
    .join("\n\n")
    .trim();
}

export function renderPromptBundle(bundle: GroundingBundle): string {
  return renderPromptSections([...bundle.staticSections, ...bundle.dynamicSections]);
}
