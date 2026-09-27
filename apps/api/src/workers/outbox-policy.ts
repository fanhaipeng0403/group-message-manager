import type { AccountStatus } from "@platform/contracts";
import { GatewayError } from "../integrations/gateway/client.js";

export type SendCompensation =
  | { kind: "rate_limit"; retryAfterSeconds: number }
  | { kind: "mark_unknown" }
  | { kind: "terminal_account"; status: Extract<AccountStatus, "suspended" | "session_expired"> }
  | { kind: "account_offline" }
  | { kind: "mark_group_unreachable" }
  | { kind: "retry_later" }
  | { kind: "fail_permanently"; code: string };

/** Converts unstable gateway errors into explicit durable compensation actions. */
export function classifySendFailure(error: unknown): SendCompensation {
  if (!(error instanceof GatewayError)) return { kind: "mark_unknown" };
  if (error.code === "RATE_LIMITED") {
    return { kind: "rate_limit", retryAfterSeconds: Math.max(error.retryAfterSeconds ?? 1, 1) };
  }
  if (error.code === "NETWORK_TIMEOUT") return { kind: "mark_unknown" };
  if (error.code === "ACCOUNT_SUSPENDED") return { kind: "terminal_account", status: "suspended" };
  if (error.code === "SESSION_EXPIRED") return { kind: "terminal_account", status: "session_expired" };
  if (error.code === "ACCOUNT_OFFLINE") return { kind: "account_offline" };
  if (error.code === "GROUP_WRITE_FORBIDDEN") return { kind: "mark_group_unreachable" };
  if (error.status === 503) return { kind: "retry_later" };
  return { kind: "fail_permanently", code: error.code };
}

export type UnknownReconciliation = "retry_once" | "fail_timeout" | "defer_reconciliation";

export function classifyUnknownReconciliation(error: unknown, retryCount: number): UnknownReconciliation {
  if (error instanceof GatewayError && error.status === 404) {
    return retryCount < 1 ? "retry_once" : "fail_timeout";
  }
  return "defer_reconciliation";
}
