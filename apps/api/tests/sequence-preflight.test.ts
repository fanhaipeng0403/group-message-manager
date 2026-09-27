import { describe, expect, it } from "vitest";
import { AppError } from "../src/common/errors.js";
import { prepareSteps } from "../src/modules/sequences/routes.js";

const steps = [
  { index: 1, accountRole: "admin" as const, text: "{event} @ {location}", delaySeconds: 1 },
  { index: 2, accountRole: "member" as const, text: "{event} @ {location}", delaySeconds: 1 },
];

describe("sequence preflight", () => {
  it("carries step variables forward and preserves their original source", () => {
    const result = prepareSteps(
      steps,
      { event: "发布会", location: "A" },
      { "1": { location: "B" }, "2": { location: "" } },
    );
    expect(result[0]).toMatchObject({
      text: "发布会 @ B",
      varSources: { event: "default", location: "step:1" },
    });
    expect(result[1]).toMatchObject({
      text: "发布会 @ B",
      varSources: { event: "default", location: "step:1" },
    });
  });

  it("rejects the first unresolved placeholder without creating a run", () => {
    expect(() => prepareSteps(steps, { event: "发布会" }, {})).toThrowError(
      expect.objectContaining<AppError>({
        code: "UNRESOLVED_PLACEHOLDER",
        details: { stepIndex: 1, key: "location" },
      }),
    );
  });
});
