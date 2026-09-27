CREATE TABLE sequences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  steps jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sequence_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  sequence_id uuid NOT NULL REFERENCES sequences(id),
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'finished', 'failed', 'stopped')),
  current_step_index integer NOT NULL DEFAULT 1,
  lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX one_running_sequence_per_group
  ON sequence_runs (group_id) WHERE status = 'running';

CREATE TABLE sequence_run_steps (
  run_id uuid NOT NULL REFERENCES sequence_runs(id) ON DELETE CASCADE,
  step_index integer NOT NULL,
  account_role text NOT NULL CHECK (account_role IN ('admin', 'member')),
  text text NOT NULL,
  delay_seconds integer NOT NULL CHECK (delay_seconds >= 0),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'sent', 'skipped', 'failed')),
  scheduled_at timestamptz,
  sent_at timestamptz,
  client_msg_id text,
  resolved_vars jsonb NOT NULL,
  var_sources jsonb NOT NULL,
  PRIMARY KEY (run_id, step_index)
);

INSERT INTO sequences (name, steps) VALUES (
  '活动提醒序列',
  '[{"index":1,"accountRole":"admin","text":"{event} 将于 {time} 开始，请提前准备","delaySeconds":1},{"index":2,"accountRole":"member","text":"提醒：{event} 的资料已上传到 {location}","delaySeconds":1}]'::jsonb
);
