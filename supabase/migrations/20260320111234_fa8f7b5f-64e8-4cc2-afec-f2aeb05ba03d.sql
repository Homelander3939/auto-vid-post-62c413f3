-- App settings (single row per app instance, no auth needed for this solo tool)
CREATE TABLE public.app_settings (
  id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  folder_path TEXT NOT NULL DEFAULT '',
  youtube_email TEXT NOT NULL DEFAULT '',
  youtube_password TEXT NOT NULL DEFAULT '',
  youtube_enabled BOOLEAN NOT NULL DEFAULT false,
  tiktok_email TEXT NOT NULL DEFAULT '',
  tiktok_password TEXT NOT NULL DEFAULT '',
  tiktok_enabled BOOLEAN NOT NULL DEFAULT false,
  instagram_email TEXT NOT NULL DEFAULT '',
  instagram_password TEXT NOT NULL DEFAULT '',
  instagram_enabled BOOLEAN NOT NULL DEFAULT false,
  telegram_bot_token TEXT NOT NULL DEFAULT '',
  telegram_chat_id TEXT NOT NULL DEFAULT '',
  telegram_enabled BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read settings" ON public.app_settings FOR SELECT USING (true);
CREATE POLICY "Anyone can insert settings" ON public.app_settings FOR INSERT WITH CHECK (true);
CREATE POLICY "Anyone can update settings" ON public.app_settings FOR UPDATE USING (true);

INSERT INTO public.app_settings (id) VALUES (1);

-- Upload jobs
CREATE TABLE public.upload_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  video_file_name TEXT NOT NULL,
  video_storage_path TEXT,
  title TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  tags TEXT[] NOT NULL DEFAULT '{}',
  target_platforms TEXT[] NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  platform_results JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

ALTER TABLE public.upload_jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read jobs" ON public.upload_jobs FOR SELECT USING (true);
CREATE POLICY "Anyone can create jobs" ON public.upload_jobs FOR INSERT WITH CHECK (true);
CREATE POLICY "Anyone can update jobs" ON public.upload_jobs FOR UPDATE USING (true);
CREATE POLICY "Anyone can delete jobs" ON public.upload_jobs FOR DELETE USING (true);

-- Schedule config
CREATE TABLE public.schedule_config (
  id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  enabled BOOLEAN NOT NULL DEFAULT false,
  cron_expression TEXT NOT NULL DEFAULT '0 9 * * *',
  platforms TEXT[] NOT NULL DEFAULT '{youtube,tiktok,instagram}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.schedule_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read schedule" ON public.schedule_config FOR SELECT USING (true);
CREATE POLICY "Anyone can insert schedule" ON public.schedule_config FOR INSERT WITH CHECK (true);
CREATE POLICY "Anyone can update schedule" ON public.schedule_config FOR UPDATE USING (true);

INSERT INTO public.schedule_config (id) VALUES (1);

-- Storage bucket for video uploads
INSERT INTO storage.buckets (id, name, public) VALUES ('videos', 'videos', true);

CREATE POLICY "Anyone can upload videos" ON storage.objects FOR INSERT WITH CHECK (bucket_id = 'videos');
CREATE POLICY "Anyone can read videos" ON storage.objects FOR SELECT USING (bucket_id = 'videos');
CREATE POLICY "Anyone can delete videos" ON storage.objects FOR DELETE USING (bucket_id = 'videos');

-- Update timestamp function
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

CREATE TRIGGER update_settings_ts BEFORE UPDATE ON public.app_settings
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_schedule_ts BEFORE UPDATE ON public.schedule_config
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();