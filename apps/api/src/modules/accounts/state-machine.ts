import type { AccountStatus } from "@platform/contracts";

const transitions: Record<AccountStatus, readonly AccountStatus[]> = {
  idle: ["online", "suspended", "session_expired"],
  online: ["idle", "rate_limited", "disconnected", "suspended", "session_expired"],
  rate_limited: ["online", "disconnected", "suspended", "session_expired"],
  disconnected: ["idle", "online", "suspended", "session_expired"],
  suspended: [],
  session_expired: [],
};

export function canTransition(from: AccountStatus, to: AccountStatus): boolean {
  return transitions[from].includes(to);
}

export function allowedTargets(from: AccountStatus): readonly AccountStatus[] {
  return transitions[from];
}
