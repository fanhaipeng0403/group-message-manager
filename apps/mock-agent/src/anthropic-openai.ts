type AnthropicBlock = Record<string, unknown>;
type AnthropicMessage = { role: "user" | "assistant"; content: AnthropicBlock[] };

type OpenAiTool = {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
};

type OpenAiMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: OpenAiToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

type OpenAiToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export function toolsToOpenAi(
  tools: Array<{ name: string; description: string; input_schema: Record<string, unknown> }>,
): OpenAiTool[] {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
    },
  }));
}

export function anthropicMessagesToOpenAi(
  messages: AnthropicMessage[],
  systemPrompt: string,
): OpenAiMessage[] {
  const openAi: OpenAiMessage[] = [{ role: "system", content: systemPrompt }];
  for (const message of messages) {
    for (const block of message.content) {
      const type = block.type;
      if (type === "text" && typeof block.text === "string") {
        openAi.push({
          role: message.role,
          content: block.text,
        });
        continue;
      }
      if (type === "tool_use" && message.role === "assistant") {
        const name = String(block.name ?? "");
        const id = String(block.id ?? "");
        const input = (block.input as Record<string, unknown>) ?? {};
        openAi.push({
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id,
              type: "function",
              function: { name, arguments: JSON.stringify(input) },
            },
          ],
        });
        continue;
      }
      if (type === "tool_result" && message.role === "user") {
        const toolUseId = String(block.tool_use_id ?? "");
        const content =
          typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? {});
        openAi.push({ role: "tool", tool_call_id: toolUseId, content });
      }
    }
  }
  return openAi;
}

export type AgentTurnPayload =
  | {
      stop_reason: "tool_use";
      content: [{ type: "tool_use"; id: string; name: string; input: Record<string, unknown> }];
    }
  | { stop_reason: "end_turn"; content: [{ type: "text"; text: string }] };

export function openAiChoiceToAgentTurn(choice: {
  message?: {
    content?: string | null;
    tool_calls?: OpenAiToolCall[];
  };
}): AgentTurnPayload {
  const toolCalls = choice.message?.tool_calls ?? [];
  if (toolCalls.length > 0) {
    const call = toolCalls[0]!;
    let input: Record<string, unknown> = {};
    try {
      input = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
    } catch {
      input = {};
    }
    return {
      stop_reason: "tool_use",
      content: [
        {
          type: "tool_use",
          id: call.id || `tu_${crypto.randomUUID()}`,
          name: call.function.name,
          input,
        },
      ],
    };
  }
  const text = choice.message?.content?.trim() || "Done.";
  return {
    stop_reason: "end_turn",
    content: [{ type: "text", text }],
  };
}
