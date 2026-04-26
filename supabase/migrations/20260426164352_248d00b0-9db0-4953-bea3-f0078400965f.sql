ALTER TABLE public.schedule_config
  ADD COLUMN IF NOT EXISTS account_selections jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS run_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS max_runs integer;