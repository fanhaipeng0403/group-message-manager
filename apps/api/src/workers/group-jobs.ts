import type { DbPool } from "../db/pool.js";
import { GatewayClient, GatewayError } from "../integrations/gateway/client.js";
import { sleep } from "../common/sleep.js";

interface CreateGroupPayload {
  creatorAccountId: string;
  memberAccountIds: string[];
}
interface CreateGroupState {
  gatewayGroupId?: string;
  localGroupId?: string;
  inviteLink?: string;
  readyAt?: number;
  joined?: string[];
}
interface LeaveAllPayload {
  groupId: string;
}

interface Logger {
  error(obj: unknown, message: string): void;
}

export class GroupJobWorker {
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly pool: DbPool,
    private readonly gateway: GatewayClient,
    private readonly log: Logger,
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.tick(), 500);
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const result = await this.pool.query<{
        id: string;
        type: "create_group" | "leave_all";
        payload: CreateGroupPayload | LeaveAllPayload;
        state: CreateGroupState;
      }>(
        `UPDATE jobs SET lease_until = now() + interval '15 seconds', updated_at = now()
         WHERE id = (
           SELECT id FROM jobs WHERE status = 'running'
             AND (lease_until IS NULL OR lease_until < now())
           ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1
         ) RETURNING id, type, payload, state`,
      );
      const job = result.rows[0];
      if (job?.type === "create_group")
        await this.process(job.id, job.payload as CreateGroupPayload, job.state);
      if (job?.type === "leave_all") await this.processLeaveAll(job.id, job.payload as LeaveAllPayload);
    } catch (error) {
      this.log.error({ err: error }, "group job worker failed");
    } finally {
      this.running = false;
    }
  }

  private async process(
    id: string,
    payload: CreateGroupPayload,
    initialState: CreateGroupState,
  ): Promise<void> {
    const state = { ...initialState, joined: [...(initialState.joined ?? [])] };
    let step = "create";
    try {
      if (!state.gatewayGroupId) {
        const created = await this.gateway.createGroup(payload.creatorAccountId);
        state.gatewayGroupId = created.groupId;
        const creator = await this.pool.query<{ platform_user_id: string }>(
          "SELECT platform_user_id FROM accounts WHERE id = $1",
          [payload.creatorAccountId],
        );
        const group = await this.pool.query<{ id: string }>(
          `INSERT INTO groups (gateway_group_id, creator_account_id) VALUES ($1, $2)
           ON CONFLICT (gateway_group_id) DO UPDATE SET gateway_group_id = EXCLUDED.gateway_group_id RETURNING id`,
          [state.gatewayGroupId, payload.creatorAccountId],
        );
        state.localGroupId = group.rows[0]!.id;
        await this.pool.query(
          `INSERT INTO group_members (group_id, account_id, platform_user_id, role)
           VALUES ($1, $2, $3, 'creator') ON CONFLICT DO NOTHING`,
          [state.localGroupId, payload.creatorAccountId, creator.rows[0]!.platform_user_id],
        );
        await this.saveState(id, state);
      }

      step = "invite";
      if (!state.inviteLink) {
        const invitation = await this.gateway.invite(state.gatewayGroupId);
        state.inviteLink = invitation.inviteLink;
        state.readyAt = Date.now() + invitation.readyAfterMs;
        await this.saveState(id, state);
      }
      if (state.readyAt && state.readyAt > Date.now()) await sleep(state.readyAt - Date.now());

      for (const accountId of payload.memberAccountIds) {
        if (state.joined.includes(accountId)) continue;
        step = `join:${accountId}`;
        let joinedRemotely = false;
        let renewedInvite = false;
        const joinDeadline = Date.now() + 10_000;
        while (!joinedRemotely) {
          try {
            await this.gateway.join(state.gatewayGroupId, accountId, state.inviteLink);
            joinedRemotely = true;
          } catch (error) {
            if (!(error instanceof GatewayError)) throw error;
            if (error.code === "ALREADY_MEMBER") {
              await this.ensureLocalMember(state.localGroupId!, accountId);
              joinedRemotely = true;
              break;
            }
            if (error.code === "INVITE_NOT_READY" && Date.now() < joinDeadline) {
              await sleep(Math.max(100, (state.readyAt ?? Date.now()) - Date.now()));
              continue;
            }
            if (error.code === "INVITE_EXPIRED" && !renewedInvite) {
              const invitation = await this.gateway.invite(state.gatewayGroupId);
              state.inviteLink = invitation.inviteLink;
              state.readyAt = Date.now() + invitation.readyAfterMs;
              renewedInvite = true;
              await this.saveState(id, state);
              if (invitation.readyAfterMs) await sleep(invitation.readyAfterMs);
              continue;
            }
            throw error;
          }
        }
        await this.waitForMember(state.localGroupId!, accountId, Math.max(1, joinDeadline - Date.now()));
        state.joined.push(accountId);
        await this.saveState(id, state);
      }

      step = "promote";
      const adminId = payload.memberAccountIds[0]!;
      try {
        await this.gateway.promote(state.gatewayGroupId, payload.creatorAccountId, adminId);
      } catch (error) {
        if (!(error instanceof GatewayError && error.code === "NOT_MEMBER_YET")) throw error;
        await sleep(250);
        await this.gateway.promote(state.gatewayGroupId, payload.creatorAccountId, adminId);
      }
      await this.pool.query(
        "UPDATE group_members SET role = 'admin' WHERE group_id = $1 AND account_id = $2",
        [state.localGroupId, adminId],
      );
      await this.pool.query(
        "UPDATE jobs SET status = 'finished', lease_until = NULL, updated_at = now() WHERE id = $1",
        [id],
      );
    } catch (error) {
      const code =
        error instanceof GatewayError
          ? error.code
          : error instanceof Error && error.message === "JOIN_TIMEOUT"
            ? "JOIN_TIMEOUT"
            : "JOB_FAILED";
      await this.pool.query(
        `UPDATE jobs SET status = 'failed', errors = $2, lease_until = NULL, updated_at = now() WHERE id = $1`,
        [id, JSON.stringify([{ step, code }])],
      );
    }
  }

  private async saveState(id: string, state: CreateGroupState): Promise<void> {
    await this.pool.query(
      "UPDATE jobs SET state = $2, lease_until = now() + interval '15 seconds', updated_at = now() WHERE id = $1",
      [id, state],
    );
  }

  private async waitForMember(groupId: string, accountId: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const result = await this.pool.query(
        "SELECT 1 FROM group_members WHERE group_id = $1 AND account_id = $2",
        [groupId, accountId],
      );
      if (result.rowCount) return;
      await sleep(100);
    }
    throw new Error("JOIN_TIMEOUT");
  }

  private async ensureLocalMember(groupId: string, accountId: string): Promise<void> {
    const account = await this.pool.query<{ platform_user_id: string }>(
      "SELECT platform_user_id FROM accounts WHERE id = $1",
      [accountId],
    );
    if (!account.rows[0]?.platform_user_id) throw new Error("ACCOUNT_NOT_CONNECTED");
    await this.pool.query(
      `INSERT INTO group_members (group_id, account_id, platform_user_id, role)
       VALUES ($1, $2, $3, 'member') ON CONFLICT DO NOTHING`,
      [groupId, accountId, account.rows[0].platform_user_id],
    );
  }

  private async processLeaveAll(id: string, payload: LeaveAllPayload): Promise<void> {
    const group = await this.pool.query<{ gateway_group_id: string; creator_account_id: string }>(
      "SELECT gateway_group_id, creator_account_id FROM groups WHERE id = $1",
      [payload.groupId],
    );
    const current = group.rows[0];
    if (!current) {
      await this.failJob(id, [{ step: "leave:group", code: "GROUP_NOT_FOUND" }]);
      return;
    }
    const members = await this.pool.query<{ account_id: string }>(
      "SELECT account_id FROM group_members WHERE group_id = $1 AND account_id IS NOT NULL ORDER BY account_id",
      [payload.groupId],
    );
    const errors: Array<{ step: string; code: string }> = [];
    for (const member of members.rows.filter((row) => row.account_id !== current.creator_account_id)) {
      try {
        await this.gateway.leave(current.gateway_group_id, member.account_id);
        await this.pool.query("DELETE FROM group_members WHERE group_id = $1 AND account_id = $2", [
          payload.groupId,
          member.account_id,
        ]);
      } catch (error) {
        errors.push({
          step: `leave:${member.account_id}`,
          code: error instanceof GatewayError ? error.code : "LEAVE_FAILED",
        });
      }
    }
    if (errors.length) {
      await this.failJob(id, errors);
      return;
    }
    try {
      await this.gateway.leave(current.gateway_group_id, current.creator_account_id);
      await this.pool.query("DELETE FROM group_members WHERE group_id = $1", [payload.groupId]);
      await this.pool.query("UPDATE groups SET status = 'left', updated_at = now() WHERE id = $1", [
        payload.groupId,
      ]);
      await this.pool.query(
        "UPDATE jobs SET status = 'finished', lease_until = NULL, updated_at = now() WHERE id = $1",
        [id],
      );
    } catch (error) {
      await this.failJob(id, [
        {
          step: `leave:${current.creator_account_id}`,
          code: error instanceof GatewayError ? error.code : "LEAVE_FAILED",
        },
      ]);
    }
  }

  private async failJob(id: string, errors: Array<{ step: string; code: string }>): Promise<void> {
    await this.pool.query(
      "UPDATE jobs SET status = 'failed', errors = $2, lease_until = NULL, updated_at = now() WHERE id = $1",
      [id, JSON.stringify(errors)],
    );
  }
}
