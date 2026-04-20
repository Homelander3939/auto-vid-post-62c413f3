ALTER TABLE public.social_post_schedules
  ADD COLUMN IF NOT EXISTS auto_publish boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS topic_mode boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS variation_hints text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS run_count integer NOT NULL DEFAULT 0;