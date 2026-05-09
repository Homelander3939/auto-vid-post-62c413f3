ALTER TABLE public.social_post_schedules
  ADD COLUMN IF NOT EXISTS source_type text NOT NULL DEFAULT 'ai',
  ADD COLUMN IF NOT EXISTS folder_path text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS posts_per_run integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS imported_files text[] NOT NULL DEFAULT '{}'::text[];