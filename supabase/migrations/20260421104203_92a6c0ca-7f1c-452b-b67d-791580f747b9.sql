CREATE TABLE public.agent_runs (
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
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  completed_at TIMESTAMP WITH TIME ZONE
);

ALTER TABLE public.agent_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read agent_runs" ON public.agent_runs FOR SELECT USING (true);
CREATE POLICY "Anyone can insert agent_runs" ON public.agent_runs FOR INSERT WITH CHECK (true);
CREATE POLICY "Anyone can update agent_runs" ON public.agent_runs FOR UPDATE USING (true);
CREATE POLICY "Anyone can delete agent_runs" ON public.agent_runs FOR DELETE USING (true);

CREATE TRIGGER update_agent_runs_updated_at
BEFORE UPDATE ON public.agent_runs
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

CREATE INDEX idx_agent_runs_status_created ON public.agent_runs (status, created_at DESC);

ALTER TABLE public.app_settings
  ADD COLUMN IF NOT EXISTS agent_shell_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS agent_workspace_path TEXT NOT NULL DEFAULT '';

ALTER PUBLICATION supabase_realtime ADD TABLE public.agent_runs;
ALTER TABLE public.agent_runs REPLICA IDENTITY FULL;