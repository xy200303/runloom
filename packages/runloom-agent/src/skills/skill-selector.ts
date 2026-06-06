import type { RunloomSkillActivation, RunloomSkillSummary } from "../types.js";

export interface SelectSkillActivationsInput {
  text: string;
  taskType?: string;
  language?: string;
  availableTools: string[];
  skills: RunloomSkillSummary[];
  maxActivations?: number;
}

export interface SkillSelectionResult {
  activations: RunloomSkillActivation[];
  diagnostics: Array<{ skillName: string; reason: string }>;
}

interface ScoredSkill {
  skill: RunloomSkillSummary;
  reason: string;
  confidence: number;
}

export function selectSkillActivations(input: SelectSkillActivationsInput): SkillSelectionResult {
  const diagnostics: SkillSelectionResult["diagnostics"] = [];
  const availableTools = new Set(input.availableTools);
  const scored: ScoredSkill[] = [];

  for (const skill of input.skills) {
    if (!skill.enabled) {
      continue;
    }
    const missingTools = (skill.requiredTools ?? []).filter((tool) => !availableTools.has(tool));
    if (missingTools.length > 0) {
      diagnostics.push({
        skillName: skill.name,
        reason: `missing required tools: ${missingTools.join(", ")}`
      });
      continue;
    }
    const score = scoreSkill(skill, input);
    if (score) {
      scored.push(score);
    }
  }

  const activations = scored
    .sort((a, b) => b.confidence - a.confidence || a.skill.name.localeCompare(b.skill.name))
    .slice(0, input.maxActivations ?? 3)
    .map((item) => ({
      skillName: item.skill.name,
      version: item.skill.version,
      reason: item.reason,
      confidence: item.confidence,
      contextBudgetTokens: contextBudgetForConfidence(item.confidence)
    }));

  return {
    activations,
    diagnostics
  };
}

function scoreSkill(skill: RunloomSkillSummary, input: SelectSkillActivationsInput): ScoredSkill | undefined {
  const normalizedText = normalize(input.text);
  const taskType = normalize(input.taskType ?? "");
  const language = normalize(input.language ?? "");
  const triggers = skill.triggers ?? [];

  for (const trigger of triggers) {
    const normalizedTrigger = normalize(trigger);
    if (!normalizedTrigger) {
      continue;
    }
    if (normalizedText.includes(normalizedTrigger)) {
      return {
        skill,
        reason: `trigger matched user input: ${trigger}`,
        confidence: 0.92
      };
    }
    if (taskType && normalizedTrigger.includes(taskType)) {
      return {
        skill,
        reason: `trigger matched task type: ${input.taskType}`,
        confidence: 0.82
      };
    }
    if (language && normalizedTrigger.includes(language)) {
      return {
        skill,
        reason: `trigger matched language: ${input.language}`,
        confidence: 0.74
      };
    }
  }

  const haystack = normalize(`${skill.name} ${skill.description}`);
  if (taskType && haystack.includes(taskType)) {
    return {
      skill,
      reason: `skill metadata matched task type: ${input.taskType}`,
      confidence: 0.68
    };
  }
  if (language && haystack.includes(language)) {
    return {
      skill,
      reason: `skill metadata matched language: ${input.language}`,
      confidence: 0.62
    };
  }
  return undefined;
}

function contextBudgetForConfidence(confidence: number): number {
  if (confidence >= 0.9) {
    return 1200;
  }
  if (confidence >= 0.75) {
    return 900;
  }
  return 600;
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}
