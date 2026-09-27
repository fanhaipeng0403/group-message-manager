CREATE TABLE reliability_experiments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scenario text NOT NULL CHECK (scenario IN ('s2_duplicate', 's4_rate_limit', 's5_agent_idempotency', 's6_agent_protocol', 'agent_happy')),
  group_id uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  account_id text REFERENCES accounts(id),
  client_msg_id text,
  trigger_msg_id text,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'passed', 'failed')),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX reliability_experiments_group_idx
  ON reliability_experiments (group_id, created_at DESC);

CREATE UNIQUE INDEX one_running_reliability_experiment
  ON reliability_experiments ((1)) WHERE status = 'running';
