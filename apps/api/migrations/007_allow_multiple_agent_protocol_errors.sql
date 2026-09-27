ALTER TABLE agent_steps
  DROP CONSTRAINT IF EXISTS agent_steps_run_id_tool_use_id_key;

-- PostgreSQL UNIQUE allows multiple NULL values. Protocol-error and final steps
-- have no tool_use_id, while real tool calls must remain unique within a run.
ALTER TABLE agent_steps
  ADD CONSTRAINT agent_steps_run_id_tool_use_id_key UNIQUE (run_id, tool_use_id);
