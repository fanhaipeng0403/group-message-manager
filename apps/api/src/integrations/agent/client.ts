export interface AgentTurnRequest {
  runId: string;
  tools: Array<{ name: string; description: string; input_schema: Record<string, unknown> }>;
  messages: Array<Record<string, unknown>>;
}

export class AgentClient {
  constructor(
    private readonly baseUrl: string,
    private readonly turnTimeoutMs: number,
  ) {}

  async turn(body: AgentTurnRequest): Promise<{ status: number; raw: string }> {
    const response = await fetch(`${this.baseUrl}/agent/turn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.turnTimeoutMs),
    });
    return { status: response.status, raw: await response.text() };
  }

  async audit(text: string, groupId: string): Promise<"pass" | "fail"> {
    const response = await fetch(`${this.baseUrl}/agent/audit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, groupId }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`Audit HTTP ${response.status}`);
    const body = (await response.json()) as { verdict?: unknown };
    if (body.verdict !== "pass" && body.verdict !== "fail") throw new Error("Invalid audit response");
    return body.verdict;
  }

  async configureDemo(mode: "normal" | "s5_retry_same_key" | "s6_bad_then_unknown"): Promise<void> {
    const response = await fetch(`${this.baseUrl}/__control`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`Agent demo control HTTP ${response.status}`);
  }
}
