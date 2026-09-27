import { describe, expect, it } from "vitest";
import type { Sequence } from "../api/client";
import { buildSequencePreview } from "./sequence-preview";

const sequence: Sequence = {
  id: "sequence-1",
  name: "活动提醒",
  steps: [
    {
      index: 1,
      accountRole: "admin",
      text: "{event} 将于 {time} 开始",
      delaySeconds: 1,
    },
    {
      index: 2,
      accountRole: "member",
      text: "{event} 的资料在 {location}",
      delaySeconds: 1,
    },
  ],
};

describe("自动任务变量预检", () => {
  it("从指定步骤起沿用覆盖值，并标记变量来源", () => {
    const preview = buildSequencePreview(
      sequence,
      { event: "发布会", time: "20:00", location: "共享盘" },
      { "2": { location: "群文件" } },
    );

    expect(preview[0]?.text).toBe("发布会 将于 20:00 开始");
    expect(preview[1]?.text).toBe("发布会 的资料在 群文件");
    expect(preview[1]?.variables).toContainEqual({ key: "location", value: "群文件", source: "step:2" });
    expect(preview[1]?.variables).toContainEqual({ key: "event", value: "发布会", source: "default" });
  });

  it("允许步骤覆盖补齐没有公共默认值的变量", () => {
    const preview = buildSequencePreview(
      sequence,
      { event: "发布会", time: "20:00", location: "" },
      { "2": { location: "群文件" } },
    );

    expect(preview[1]?.text).toContain("群文件");
  });

  it("明确指出缺少变量的步骤和 key", () => {
    expect(() => buildSequencePreview(sequence, { event: "发布会" }, {})).toThrow("第 1 步缺少变量 time");
  });
});
