ALTER TABLE public.app_settings
  ADD COLUMN IF NOT EXISTS agent_task_mode TEXT NOT NULL DEFAULT 'standard',
  ADD COLUMN IF NOT EXISTS agent_automation_mode TEXT NOT NULL DEFAULT 'safe',
  ADD COLUMN IF NOT EXISTS agent_memory_enabled BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS agent_memory_max_items INTEGER NOT NULL DEFAULT 8,
  ADD COLUMN IF NOT EXISTS agent_shell_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS agent_workspace_path TEXT NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS public.agent_runs (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  prompt TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'running',
  events JSONB NOT NULL DEFAULT '[]'::jsonb,
  model TEXT NOT NULL DEFAULT '',
  workspace_path TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'web',
  telegram_chat_id TEXT,
  telegram_status_message_id BIGINT,
  result JSONB,
  error TEXT,
  task_mode TEXT NOT NULL DEFAULT 'standard',
  automation_mode TEXT NOT NULL DEFAULT 'safe',
  memory_snapshot JSONB NOT NULL DEFAULT '[]'::jsonb,
  skill_id UUID,
  pending_skill JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

ALTER TABLE public.agent_runs
  ADD COLUMN IF NOT EXISTS task_mode TEXT NOT NULL DEFAULT 'standard',
  ADD COLUMN IF NOT EXISTS automation_mode TEXT NOT NULL DEFAULT 'safe',
  ADD COLUMN IF NOT EXISTS memory_snapshot JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS skill_id UUID,
  ADD COLUMN IF NOT EXISTS pending_skill JSONB;

ALTER TABLE public.agent_runs ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'agent_runs' AND policyname = 'Anyone can read agent_runs'
  ) THEN
    CREATE POLICY "Anyone can read agent_runs" ON public.agent_runs FOR SELECT USING (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'agent_runs' AND policyname = 'Anyone can insert agent_runs'
  ) THEN
    CREATE POLICY "Anyone can insert agent_runs" ON public.agent_runs FOR INSERT WITH CHECK (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'agent_runs' AND policyname = 'Anyone can update agent_runs'
  ) THEN
    CREATE POLICY "Anyone can update agent_runs" ON public.agent_runs FOR UPDATE USING (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'agent_runs' AND policyname = 'Anyone can delete agent_runs'
  ) THEN
    CREATE POLICY "Anyone can delete agent_runs" ON public.agent_runs FOR DELETE USING (true);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_agent_runs_status_created
  ON public.agent_runs (status, created_at DESC);

DROP TRIGGER IF EXISTS update_agent_runs_updated_at ON public.agent_runs;
CREATE TRIGGER update_agent_runs_updated_at
BEFORE UPDATE ON public.agent_runs
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TABLE IF NOT EXISTS public.agent_skills (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'manual',
  source_url TEXT,
  triggers TEXT[] NOT NULL DEFAULT '{}',
  steps JSONB NOT NULL DEFAULT '[]'::jsonb,
  system_prompt TEXT NOT NULL DEFAULT '',
  tags TEXT[] NOT NULL DEFAULT '{}',
  enabled BOOLEAN NOT NULL DEFAULT true,
  is_routine BOOLEAN NOT NULL DEFAULT false,
  routine_cron TEXT,
  routine_last_run_at TIMESTAMPTZ,
  use_count INTEGER NOT NULL DEFAULT 0,
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.agent_skills
  ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS source_url TEXT,
  ADD COLUMN IF NOT EXISTS triggers TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS steps JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS system_prompt TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS enabled BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS is_routine BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS routine_cron TEXT,
  ADD COLUMN IF NOT EXISTS routine_last_run_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS use_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

ALTER TABLE public.agent_skills ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'agent_skills' AND policyname = 'Anyone can read agent_skills'
  ) THEN
    CREATE POLICY "Anyone can read agent_skills" ON public.agent_skills FOR SELECT USING (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'agent_skills' AND policyname = 'Anyone can insert agent_skills'
  ) THEN
    CREATE POLICY "Anyone can insert agent_skills" ON public.agent_skills FOR INSERT WITH CHECK (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'agent_skills' AND policyname = 'Anyone can update agent_skills'
  ) THEN
    CREATE POLICY "Anyone can update agent_skills" ON public.agent_skills FOR UPDATE USING (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'agent_skills' AND policyname = 'Anyone can delete agent_skills'
  ) THEN
    CREATE POLICY "Anyone can delete agent_skills" ON public.agent_skills FOR DELETE USING (true);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'agent_skills_slug_key'
      AND conrelid = 'public.agent_skills'::regclass
  ) THEN
    ALTER TABLE public.agent_skills
      ADD CONSTRAINT agent_skills_slug_key UNIQUE (slug);
  END IF;
END $$;

DROP TRIGGER IF EXISTS update_agent_skills_updated_at ON public.agent_skills;
CREATE TRIGGER update_agent_skills_updated_at
BEFORE UPDATE ON public.agent_skills
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TABLE IF NOT EXISTS public.agent_memories (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  title TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  memory_type TEXT NOT NULL DEFAULT 'fact',
  tags TEXT[] NOT NULL DEFAULT '{}',
  importance INTEGER NOT NULL DEFAULT 50,
  enabled BOOLEAN NOT NULL DEFAULT true,
  source_run_id UUID,
  use_count INTEGER NOT NULL DEFAULT 0,
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.agent_memories
  ADD COLUMN IF NOT EXISTS content TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS memory_type TEXT NOT NULL DEFAULT 'fact',
  ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS importance INTEGER NOT NULL DEFAULT 50,
  ADD COLUMN IF NOT EXISTS enabled BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS source_run_id UUID,
  ADD COLUMN IF NOT EXISTS use_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

ALTER TABLE public.agent_memories ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'agent_memories' AND policyname = 'Anyone can read agent_memories'
  ) THEN
    CREATE POLICY "Anyone can read agent_memories" ON public.agent_memories FOR SELECT USING (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'agent_memories' AND policyname = 'Anyone can insert agent_memories'
  ) THEN
    CREATE POLICY "Anyone can insert agent_memories" ON public.agent_memories FOR INSERT WITH CHECK (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'agent_memories' AND policyname = 'Anyone can update agent_memories'
  ) THEN
    CREATE POLICY "Anyone can update agent_memories" ON public.agent_memories FOR UPDATE USING (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'agent_memories' AND policyname = 'Anyone can delete agent_memories'
  ) THEN
    CREATE POLICY "Anyone can delete agent_memories" ON public.agent_memories FOR DELETE USING (true);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_agent_memories_enabled_created
  ON public.agent_memories (enabled, created_at DESC);

DROP TRIGGER IF EXISTS update_agent_memories_updated_at ON public.agent_memories;
CREATE TRIGGER update_agent_memories_updated_at
BEFORE UPDATE ON public.agent_memories
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'agent_runs_skill_id_fkey'
      AND conrelid = 'public.agent_runs'::regclass
  ) THEN
    ALTER TABLE public.agent_runs
      ADD CONSTRAINT agent_runs_skill_id_fkey
      FOREIGN KEY (skill_id) REFERENCES public.agent_skills(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'agent_memories_source_run_id_fkey'
      AND conrelid = 'public.agent_memories'::regclass
  ) THEN
    ALTER TABLE public.agent_memories
      ADD CONSTRAINT agent_memories_source_run_id_fkey
      FOREIGN KEY (source_run_id) REFERENCES public.agent_runs(id) ON DELETE SET NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    IF NOT EXISTS (
      SELECT 1
      FROM pg_publication_rel pr
      JOIN pg_publication p ON p.oid = pr.prpubid
      JOIN pg_class c ON c.oid = pr.prrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE p.pubname = 'supabase_realtime' AND n.nspname = 'public' AND c.relname = 'agent_runs'
    ) THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.agent_runs;
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM pg_publication_rel pr
      JOIN pg_publication p ON p.oid = pr.prpubid
      JOIN pg_class c ON c.oid = pr.prrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE p.pubname = 'supabase_realtime' AND n.nspname = 'public' AND c.relname = 'agent_memories'
    ) THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.agent_memories;
    END IF;
  END IF;
END $$;

ALTER TABLE public.agent_runs REPLICA IDENTITY FULL;
ALTER TABLE public.agent_memories REPLICA IDENTITY FULL;

NOTIFY pgrst, 'reload schema';
