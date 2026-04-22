-- Memories table
CREATE TABLE IF NOT EXISTS public.agent_memories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  content text NOT NULL,
  memory_type text NOT NULL DEFAULT 'fact',
  tags text[] NOT NULL DEFAULT '{}',
  importance integer NOT NULL DEFAULT 50,
  enabled boolean NOT NULL DEFAULT true,
  use_count integer NOT NULL DEFAULT 0,
  last_used_at timestamptz,
  source_run_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.agent_memories ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='agent_memories' AND policyname='Anyone can read agent_memories') THEN
    CREATE POLICY "Anyone can read agent_memories" ON public.agent_memories FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='agent_memories' AND policyname='Anyone can insert agent_memories') THEN
    CREATE POLICY "Anyone can insert agent_memories" ON public.agent_memories FOR INSERT WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='agent_memories' AND policyname='Anyone can update agent_memories') THEN
    CREATE POLICY "Anyone can update agent_memories" ON public.agent_memories FOR UPDATE USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='agent_memories' AND policyname='Anyone can delete agent_memories') THEN
    CREATE POLICY "Anyone can delete agent_memories" ON public.agent_memories FOR DELETE USING (true);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_agent_memories_enabled_importance
  ON public.agent_memories (enabled, importance DESC, updated_at DESC);

DROP TRIGGER IF EXISTS update_agent_memories_updated_at ON public.agent_memories;
CREATE TRIGGER update_agent_memories_updated_at
BEFORE UPDATE ON public.agent_memories
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- agent_runs runtime columns
ALTER TABLE public.agent_runs
  ADD COLUMN IF NOT EXISTS task_mode text NOT NULL DEFAULT 'standard',
  ADD COLUMN IF NOT EXISTS automation_mode text NOT NULL DEFAULT 'safe',
  ADD COLUMN IF NOT EXISTS memory_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb;

-- app_settings agent runtime knobs
ALTER TABLE public.app_settings
  ADD COLUMN IF NOT EXISTS agent_task_mode text NOT NULL DEFAULT 'standard',
  ADD COLUMN IF NOT EXISTS agent_automation_mode text NOT NULL DEFAULT 'safe',
  ADD COLUMN IF NOT EXISTS agent_memory_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS agent_memory_max_items integer NOT NULL DEFAULT 8;
