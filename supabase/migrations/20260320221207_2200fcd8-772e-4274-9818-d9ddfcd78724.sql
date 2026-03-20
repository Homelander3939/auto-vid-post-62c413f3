-- Add name column for labeling multiple schedules
ALTER TABLE public.schedule_config ADD COLUMN IF NOT EXISTS name text NOT NULL DEFAULT 'Schedule';

-- Create sequence for auto-incrementing id
CREATE SEQUENCE IF NOT EXISTS public.schedule_config_multi_seq START WITH 2;
SELECT setval('public.schedule_config_multi_seq', GREATEST((SELECT COALESCE(MAX(id), 1) FROM public.schedule_config), 1) + 1);
ALTER TABLE public.schedule_config ALTER COLUMN id SET DEFAULT nextval('public.schedule_config_multi_seq');

-- Allow delete on schedule_config
CREATE POLICY "Anyone can delete schedule" ON public.schedule_config FOR DELETE TO public USING (true);