import type { Sequence } from "../api/client";

export interface SequencePreviewStep {
  index: number;
  role: string;
  delaySeconds: number;
  text: string;
  variables: Array<{ key: string; value: string; source: string }>;
}

export function buildSequencePreview(
  sequence: Sequence,
  defaults: Record<string, string>,
  stepVars: Record<string, Record<string, string>>,
): SequencePreviewStep[] {
  const values = Object.fromEntries(Object.entries(defaults).filter(([, value]) => value !== ""));
  const sources = Object.fromEntries(Object.keys(values).map((key) => [key, "default"]));
  return [...sequence.steps]
    .sort((a, b) => a.index - b.index)
    .map((step) => {
      for (const [key, value] of Object.entries(stepVars[String(step.index)] ?? {})) {
        if (value !== "") {
          values[key] = value;
          sources[key] = `step:${step.index}`;
        }
      }
      const keys = [...new Set([...step.text.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((match) => match[1]!))];
      const missing = keys.find((key) => !values[key]);
      if (missing) throw new UnresolvedVariableError(step.index, missing);
      return {
        index: step.index,
        role: step.accountRole === "admin" ? "管理员" : "成员",
        delaySeconds: step.delaySeconds,
        text: step.text.replace(/\{([A-Za-z0-9_]+)\}/g, (_match, key: string) => values[key]!),
        variables: Object.keys(values)
          .sort()
          .map((key) => ({ key, value: values[key]!, source: sources[key]! })),
      };
    });
}

export class UnresolvedVariableError extends Error {
  constructor(
    public readonly stepIndex: number,
    public readonly key: string,
  ) {
    super(`第 ${stepIndex} 步缺少变量 ${key}`);
  }
}
