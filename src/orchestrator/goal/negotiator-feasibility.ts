import type { ILLMClient } from "../../base/llm/llm-client.js";
import type { IPromptGateway } from "../../prompt/gateway.js";
import { FeasibilityResultSchema } from "../../base/types/negotiation.js";
import type { FeasibilityResult } from "../../base/types/negotiation.js";
import type { CharacterConfig } from "../../base/types/character.js";
import {
  buildFeasibilityPrompt,
  QualitativeFeasibilitySchema,
} from "./negotiator-prompts.js";

export const FEASIBILITY_RATIO_THRESHOLD_REALISTIC = 1.5;
export const REALISTIC_TARGET_ACCELERATION_FACTOR = 1.3;
export const DEFAULT_TIME_HORIZON_DAYS = 90;

export function getFeasibilityThreshold(characterConfig: CharacterConfig): number {
  return 1.5 + characterConfig.caution_level * 0.5;
}

export async function evaluateQualitatively(
  llmClient: ILLMClient,
  dimensionName: string,
  goalDescription: string,
  baselineValue: number | string | boolean | null,
  thresholdValue: number | string | boolean | (number | string)[] | null,
  timeHorizonDays: number,
  gateway?: IPromptGateway
): Promise<FeasibilityResult> {
  const prompt = buildFeasibilityPrompt(
    dimensionName,
    goalDescription,
    baselineValue,
    thresholdValue,
    timeHorizonDays
  );

  try {
    let parsed: {
      assessment: string;
      confidence: string;
      reasoning: string;
      key_assumptions: string[];
      main_risks: string[];
    };
    if (gateway) {
      parsed = await gateway.execute({
        purpose: "negotiation_feasibility",
        responseSchema: QualitativeFeasibilitySchema,
        additionalContext: {
          prompt,
          dimensionName,
          goalDescription,
          baselineValue: String(baselineValue),
          thresholdValue: String(thresholdValue),
          timeHorizonDays: String(timeHorizonDays),
        },
      });
    } else {
      const response = await llmClient.sendMessage(
        [{ role: "user", content: prompt }],
        { temperature: 0, model_tier: "main" }
      );
      parsed = llmClient.parseJSON(response.content, QualitativeFeasibilitySchema);
    }
    return FeasibilityResultSchema.parse({
      dimension: dimensionName,
      path: "qualitative",
      feasibility_ratio: null,
      assessment: parsed.assessment,
      confidence: parsed.confidence,
      reasoning: parsed.reasoning,
      key_assumptions: parsed.key_assumptions,
      main_risks: parsed.main_risks,
    });
  } catch {
    return FeasibilityResultSchema.parse({
      dimension: dimensionName,
      path: "qualitative",
      feasibility_ratio: null,
      assessment: "ambitious",
      confidence: "low",
      reasoning: "Failed to parse feasibility assessment, defaulting to ambitious.",
      key_assumptions: [],
      main_risks: ["Unable to assess feasibility"],
    });
  }
}
