import type { AgentRuntimeConfig } from "./config.js";
import {
  anthropicMessagesToOpenAi,
  openAiChoiceToAgentTurn,
  toolsToOpenAi,
  type AgentTurnPayload,
} from "./anthropic-openai.js";

function buildSystemPrompt(runId: string): string {
  return [
    "你是群组消息平台的自动值班助手，只能通过工具与外部世界交互。",
    "第一条 user 消息是 JSON 触发上下文，含 groupId、triggerMessages、policy.autoKickEnabled、ownPlatformUserIds。",
    "建议流程：必要时 get_recent_messages → send_message 回复用户 → finish 结束本轮。",
    "回复语言与用户 triggerMessages 一致，简洁专业。",
    `send_message 的 idempotency_key 请使用 reply-${runId}（仅首次发送；重试由平台处理）。`,
    "policy.autoKickEnabled 为 false 时不要调用 kick_user。",
    "每轮只应产生一个工具调用。",
  ].join("\n");
}

export async function handleQwenTurn(input: {
  config: AgentRuntimeConfig;
  runId: string;
  tools: Array<{ name: string; description: string; input_schema: Record<string, unknown> }>;
  messages: Array<{ role: "user" | "assistant"; content: Record<string, unknown>[] }>;
}): Promise<AgentTurnPayload> {
  const { config, runId, tools, messages } = input;
  const apiKey = config.dashscopeApiKey;
  if (!apiKey) throw new Error("DASHSCOPE_API_KEY is not configured");

  const openAiMessages = anthropicMessagesToOpenAi(messages, buildSystemPrompt(runId));
  const url = `${config.dashscopeBaseUrl.replace(/\/$/, "")}/chat/completions`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: config.dashscopeModel,
      messages: openAiMessages,
      tools: toolsToOpenAi(tools),
      tool_choice: "auto",
      temperature: 0.3,
    }),
    signal: AbortSignal.timeout(Math.max(1_000, config.turnTimeoutMs)),
  });

  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`DashScope HTTP ${response.status}: ${raw.slice(0, 500)}`);
  }

  let body: {
    choices?: Array<{ message?: { content?: string | null; tool_calls?: unknown[] } }>;
  };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    throw new Error("DashScope returned invalid JSON");
  }

  const choice = body.choices?.[0];
  if (!choice?.message) throw new Error("DashScope response missing choices[0].message");

  return openAiChoiceToAgentTurn({
    message: choice.message as {
      content?: string | null;
      tool_calls?: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }>;
    },
  });
}

export async function auditWithQwen(
  config: AgentRuntimeConfig,
  text: string,
  groupId: string,
): Promise<{ verdict: "pass" | "fail"; reason: string }> {
  const apiKey = config.dashscopeApiKey;
  if (!apiKey) throw new Error("DASHSCOPE_API_KEY is not configured");

  const url = `${config.dashscopeBaseUrl.replace(/\/$/, "")}/chat/completions`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: config.dashscopeModel,
      temperature: 0,
      messages: [
        {
          role: "system",
          content:
            '你是群聊内容审计员。只输出 JSON：{"verdict":"pass"|"fail","reason":"..."}。' +
            "拒绝明显违法、仇恨、诈骗、色情内容；正常业务回复与踢人指令 JSON 应 pass。",
        },
        {
          role: "user",
          content: `groupId=${groupId}\ncontent=${text}`,
        },
      ],
      response_format: { type: "json_object" },
    }),
    signal: AbortSignal.timeout(Math.min(8_000, config.turnTimeoutMs)),
  });

  const raw = await response.text();
  if (!response.ok) throw new Error(`DashScope audit HTTP ${response.status}`);

  const parsed = JSON.parse(raw) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = parsed.choices?.[0]?.message?.content;
  if (!content) throw new Error("DashScope audit empty content");

  const verdictBody = JSON.parse(content) as { verdict?: string; reason?: string };
  if (verdictBody.verdict !== "pass" && verdictBody.verdict !== "fail") {
    throw new Error("DashScope audit invalid verdict");
  }
  return {
    verdict: verdictBody.verdict,
    reason: verdictBody.reason ?? (verdictBody.verdict === "pass" ? "Approved" : "Rejected"),
  };
}
