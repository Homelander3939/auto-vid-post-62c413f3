-- Social post accounts (mirrors platform_accounts)
CREATE TABLE public.social_post_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  platform text NOT NULL,
  label text NOT NULL DEFAULT '',
  email text NOT NULL DEFAULT '',
  password text NOT NULL DEFAULT '',
  enabled boolean NOT NULL DEFAULT true,
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.social_post_accounts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read social_post_accounts" ON public.social_post_accounts FOR SELECT USING (true);
CREATE POLICY "Anyone can insert social_post_accounts" ON public.social_post_accounts FOR INSERT WITH CHECK (true);
CREATE POLICY "Anyone can update social_post_accounts" ON public.social_post_accounts FOR UPDATE USING (true);
CREATE POLICY "Anyone can delete social_post_accounts" ON public.social_post_accounts FOR DELETE USING (true);

-- Social posts
CREATE TABLE public.social_posts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  description text NOT NULL DEFAULT '',
  image_path text,
  hashtags text[] NOT NULL DEFAULT '{}',
  target_platforms text[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'pending',
  scheduled_at timestamptz,
  account_selections jsonb NOT NULL DEFAULT '{}'::jsonb,
  ai_prompt text,
  ai_sources jsonb NOT NULL DEFAULT '[]'::jsonb,
  platform_results jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

ALTER TABLE public.social_posts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read social_posts" ON public.social_posts FOR SELECT USING (true);
CREATE POLICY "Anyone can insert social_posts" ON public.social_posts FOR INSERT WITH CHECK (true);
CREATE POLICY "Anyone can update social_posts" ON public.social_posts FOR UPDATE USING (true);
CREATE POLICY "Anyone can delete social_posts" ON public.social_posts FOR DELETE USING (true);

-- Recurring schedules for social posts
CREATE TABLE public.social_post_schedules (
  id serial PRIMARY KEY,
  name text NOT NULL DEFAULT 'Social Schedule',
  enabled boolean NOT NULL DEFAULT false,
  cron_expression text NOT NULL DEFAULT '0 9 * * *',
  upload_interval_minutes integer NOT NULL DEFAULT 60,
  target_platforms text[] NOT NULL DEFAULT '{x,tiktok,facebook}',
  ai_prompt text NOT NULL DEFAULT '',
  include_image boolean NOT NULL DEFAULT true,
  account_selections jsonb NOT NULL DEFAULT '{}'::jsonb,
  end_at timestamptz,
  last_run_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.social_post_schedules ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read social_post_schedules" ON public.social_post_schedules FOR SELECT USING (true);
CREATE POLICY "Anyone can insert social_post_schedules" ON public.social_post_schedules FOR INSERT WITH CHECK (true);
CREATE POLICY "Anyone can update social_post_schedules" ON public.social_post_schedules FOR UPDATE USING (true);
CREATE POLICY "Anyone can delete social_post_schedules" ON public.social_post_schedules FOR DELETE USING (true);

-- Extend app_settings with AI provider config
ALTER TABLE public.app_settings
  ADD COLUMN IF NOT EXISTS ai_provider text NOT NULL DEFAULT 'lovable',
  ADD COLUMN IF NOT EXISTS ai_api_key text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS ai_model text NOT NULL DEFAULT 'google/gemini-3-flash-preview';

-- Storage bucket for social media images
INSERT INTO storage.buckets (id, name, public) VALUES ('social-media', 'social-media', true)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "Public read social-media" ON storage.objects FOR SELECT USING (bucket_id = 'social-media');
CREATE POLICY "Public insert social-media" ON storage.objects FOR INSERT WITH CHECK (bucket_id = 'social-media');
CREATE POLICY "Public update social-media" ON storage.objects FOR UPDATE USING (bucket_id = 'social-media');
CREATE POLICY "Public delete social-media" ON storage.objects FOR DELETE USING (bucket_id = 'social-media');