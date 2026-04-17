ALTER TABLE public.social_post_schedules
  ALTER COLUMN target_platforms SET DEFAULT '{x,linkedin,facebook}'::text[];