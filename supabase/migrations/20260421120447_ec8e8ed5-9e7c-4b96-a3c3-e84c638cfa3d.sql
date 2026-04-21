
CREATE TABLE public.agent_skills (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'manual', -- 'manual' | 'github' | 'learned'
  source_url TEXT,
  triggers TEXT[] NOT NULL DEFAULT '{}', -- keywords/phrases that auto-suggest this skill
  steps JSONB NOT NULL DEFAULT '[]'::jsonb, -- ordered list of {tool, args, note}
  system_prompt TEXT NOT NULL DEFAULT '',
  tags TEXT[] NOT NULL DEFAULT '{}',
  enabled BOOLEAN NOT NULL DEFAULT true,
  is_routine BOOLEAN NOT NULL DEFAULT false, -- if true, runs on schedule
  routine_cron TEXT,
  routine_last_run_at TIMESTAMPTZ,
  use_count INTEGER NOT NULL DEFAULT 0,
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.agent_skills ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read agent_skills" ON public.agent_skills FOR SELECT USING (true);
CREATE POLICY "Anyone can insert agent_skills" ON public.agent_skills FOR INSERT WITH CHECK (true);
CREATE POLICY "Anyone can update agent_skills" ON public.agent_skills FOR UPDATE USING (true);
CREATE POLICY "Anyone can delete agent_skills" ON public.agent_skills FOR DELETE USING (true);

CREATE TRIGGER update_agent_skills_updated_at
BEFORE UPDATE ON public.agent_skills
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.agent_runs
  ADD COLUMN IF NOT EXISTS skill_id UUID,
  ADD COLUMN IF NOT EXISTS pending_skill JSONB;
