CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  role text NOT NULL CHECK (role IN ('admin', 'viewer')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE accounts (
  id text PRIMARY KEY,
  status text NOT NULL DEFAULT 'idle' CHECK (status IN ('idle', 'online', 'rate_limited', 'disconnected', 'suspended', 'session_expired')),
  platform_user_id text UNIQUE,
  rate_limited_until timestamptz,
  version integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  gateway_group_id text UNIQUE,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'unreachable', 'left')),
  creator_account_id text NOT NULL REFERENCES accounts(id),
  agent_enabled boolean NOT NULL DEFAULT false,
  auto_kick_enabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE group_members (
  group_id uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  account_id text REFERENCES accounts(id),
  platform_user_id text NOT NULL,
  role text NOT NULL CHECK (role IN ('creator', 'admin', 'member')),
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, platform_user_id),
  UNIQUE (group_id, account_id)
);

CREATE TABLE jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type text NOT NULL CHECK (type IN ('create_group', 'leave_all')),
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'finished', 'failed')),
  payload jsonb NOT NULL,
  state jsonb NOT NULL DEFAULT '{}'::jsonb,
  errors jsonb NOT NULL DEFAULT '[]'::jsonb,
  lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  account_id text REFERENCES accounts(id),
  msg_id text,
  client_msg_id text,
  sender_platform_user_id text NOT NULL,
  is_own boolean NOT NULL DEFAULT false,
  text text NOT NULL,
  sent_at timestamptz NOT NULL,
  delivery_status text CHECK (delivery_status IN ('queued', 'accepted', 'sent', 'failed', 'unknown', 'cancelled')),
  fail_code text,
  retry_count integer NOT NULL DEFAULT 0,
  dispatch_state text NOT NULL DEFAULT 'pending' CHECK (dispatch_state IN ('pending', 'inflight', 'done')),
  claimed_at timestamptz,
  next_attempt_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_msg_id),
  UNIQUE (group_id, msg_id)
);

CREATE INDEX messages_timeline_idx ON messages (group_id, sent_at DESC, id DESC);
CREATE INDEX messages_outbox_idx ON messages (delivery_status, next_attempt_at, created_at);

CREATE TABLE gateway_events (
  event_id bigint PRIMARY KEY,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  processed_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  received_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ws_events (
  seq bigserial PRIMARY KEY,
  type text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE agent_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'finished', 'failed', 'blocked', 'cancelled')),
  end_reason text,
  summary text,
  trigger_messages jsonb NOT NULL DEFAULT '[]'::jsonb,
  conversation jsonb NOT NULL DEFAULT '[]'::jsonb,
  step_count integer NOT NULL DEFAULT 0,
  consecutive_protocol_errors integer NOT NULL DEFAULT 0,
  active_elapsed_ms bigint NOT NULL DEFAULT 0,
  resumed_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX one_running_agent_per_group ON agent_runs (group_id) WHERE status = 'running';

CREATE TABLE agent_steps (
  id bigserial PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  step_index integer NOT NULL,
  kind text NOT NULL CHECK (kind IN ('tool_use', 'final', 'protocol_error')),
  tool_use_id text,
  name text,
  input jsonb,
  result_summary text NOT NULL DEFAULT '',
  is_error boolean NOT NULL DEFAULT false,
  error_code text,
  audit_verdict text,
  raw_response text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, step_index),
  UNIQUE NULLS NOT DISTINCT (run_id, tool_use_id)
);

CREATE TABLE agent_send_keys (
  run_id uuid NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL,
  message_id uuid NOT NULL REFERENCES messages(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, idempotency_key)
);

CREATE TABLE agent_trigger_messages (
  group_id uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  msg_id text NOT NULL,
  consumed_run_id uuid REFERENCES agent_runs(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, msg_id)
);

CREATE INDEX agent_trigger_pending_idx ON agent_trigger_messages (group_id, created_at)
  WHERE consumed_run_id IS NULL;

INSERT INTO accounts (id) VALUES ('account-1'), ('account-2'), ('account-3') ON CONFLICT DO NOTHING;
