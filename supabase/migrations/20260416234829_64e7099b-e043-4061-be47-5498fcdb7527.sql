CREATE TABLE public.generation_jobs (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  prompt TEXT NOT NULL DEFAULT '',
  platforms TEXT[] NOT NULL DEFAULT '{}',
  include_image BOOLEAN NOT NULL DEFAULT true,
  status TEXT NOT NULL DEFAULT 'running',
  events JSONB NOT NULL DEFAULT '[]'::jsonb,
  result JSONB,
  error TEXT,
  saved_post_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

ALTER TABLE public.generation_jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read generation_jobs" ON public.generation_jobs FOR SELECT USING (true);
CREATE POLICY "Anyone can insert generation_jobs" ON public.generation_jobs FOR INSERT WITH CHECK (true);
CREATE POLICY "Anyone can update generation_jobs" ON public.generation_jobs FOR UPDATE USING (true);
CREATE POLICY "Anyone can delete generation_jobs" ON public.generation_jobs FOR DELETE USING (true);

CREATE TRIGGER update_generation_jobs_updated_at
BEFORE UPDATE ON public.generation_jobs
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE INDEX idx_generation_jobs_status_created ON public.generation_jobs (status, created_at DESC);

ALTER PUBLICATION supabase_realtime ADD TABLE public.generation_jobs;