ALTER TABLE public.app_settings
  ADD COLUMN IF NOT EXISTS agent_task_mode TEXT NOT NULL DEFAULT 'standard',
  ADD COLUMN IF NOT EXISTS agent_automation_mode TEXT NOT NULL DEFAULT 'safe',
  ADD COLUMN IF NOT EXISTS agent_memory_enabled BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS agent_memory_max_items INTEGER NOT NULL DEFAULT 8,
  ADD COLUMN IF NOT EXISTS agent_shell_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS agent_workspace_path TEXT NOT NULL DEFAULT '';

ALTER TABLE public.agent_runs
  ADD COLUMN IF NOT EXISTS task_mode TEXT NOT NULL DEFAULT 'standard',
  ADD COLUMN IF NOT EXISTS automation_mode TEXT NOT NULL DEFAULT 'safe',
  ADD COLUMN IF NOT EXISTS memory_snapshot JSONB NOT NULL DEFAULT '[]'::jsonb;

NOTIFY pgrst, 'reload schema';
