CREATE TABLE gateway_stream_cursor (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  last_contiguous_event_id bigint NOT NULL DEFAULT 0
);

INSERT INTO gateway_stream_cursor (singleton, last_contiguous_event_id)
VALUES (true, 0)
ON CONFLICT (singleton) DO NOTHING;

CREATE TABLE agent_kick_effects (
  run_id uuid NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  tool_use_id text NOT NULL,
  group_id uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  target_platform_user_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'succeeded', 'failed')),
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, tool_use_id)
);
