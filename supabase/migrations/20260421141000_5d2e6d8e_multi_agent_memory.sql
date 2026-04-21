ALTER TABLE public.app_settings
  ADD COLUMN IF NOT EXISTS agent_task_mode TEXT NOT NULL DEFAULT 'standard',
  ADD COLUMN IF NOT EXISTS agent_automation_mode TEXT NOT NULL DEFAULT 'safe',
  ADD COLUMN IF NOT EXISTS agent_memory_enabled BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS agent_memory_max_items INTEGER NOT NULL DEFAULT 8;

ALTER TABLE public.agent_runs
  ADD COLUMN IF NOT EXISTS task_mode TEXT NOT NULL DEFAULT 'standard',
  ADD COLUMN IF NOT EXISTS automation_mode TEXT NOT NULL DEFAULT 'safe',
  ADD COLUMN IF NOT EXISTS memory_snapshot JSONB NOT NULL DEFAULT '[]'::jsonb;

CREATE TABLE IF NOT EXISTS public.agent_memories (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  title TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  memory_type TEXT NOT NULL DEFAULT 'fact',
  tags TEXT[] NOT NULL DEFAULT '{}',
  importance INTEGER NOT NULL DEFAULT 50,
  enabled BOOLEAN NOT NULL DEFAULT true,
  source_run_id UUID REFERENCES public.agent_runs(id) ON DELETE SET NULL,
  use_count INTEGER NOT NULL DEFAULT 0,
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.agent_memories ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read agent_memories"
  ON public.agent_memories FOR SELECT USING (true);
CREATE POLICY "Anyone can insert agent_memories"
  ON public.agent_memories FOR INSERT WITH CHECK (true);
CREATE POLICY "Anyone can update agent_memories"
  ON public.agent_memories FOR UPDATE USING (true);
CREATE POLICY "Anyone can delete agent_memories"
  ON public.agent_memories FOR DELETE USING (true);

CREATE INDEX IF NOT EXISTS idx_agent_memories_enabled_created
  ON public.agent_memories (enabled, created_at DESC);

CREATE TRIGGER update_agent_memories_updated_at
BEFORE UPDATE ON public.agent_memories
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER PUBLICATION supabase_realtime ADD TABLE public.agent_memories;
ALTER TABLE public.agent_memories REPLICA IDENTITY FULL;
