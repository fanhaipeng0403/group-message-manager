export interface AgentRuntimeConfig {
  dashscopeApiKey: string | undefined;
  dashscopeBaseUrl: string;
  dashscopeModel: string;
  turnTimeoutMs: number;
}

export function loadConfig(): AgentRuntimeConfig {
  const dashscopeApiKey = process.env.DASHSCOPE_API_KEY?.trim() || undefined;
  return {
    dashscopeApiKey,
    dashscopeBaseUrl:
      process.env.DASHSCOPE_API_BASE?.trim() || "https://dashscope.aliyuncs.com/compatible-mode/v1",
    dashscopeModel: process.env.DASHSCOPE_MODEL?.trim() || "qwen-plus",
    turnTimeoutMs: Number(process.env.AGENT_TURN_TIMEOUT_MS ?? 12_000),
  };
}

export function useDashscope(config: AgentRuntimeConfig): boolean {
  return Boolean(config.dashscopeApiKey);
}
