
-- Create platform_accounts table
CREATE TABLE public.platform_accounts (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  platform TEXT NOT NULL CHECK (platform IN ('youtube', 'tiktok', 'instagram')),
  label TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  password TEXT NOT NULL DEFAULT '',
  enabled BOOLEAN NOT NULL DEFAULT true,
  is_default BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.platform_accounts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read platform_accounts" ON public.platform_accounts FOR SELECT USING (true);
CREATE POLICY "Anyone can insert platform_accounts" ON public.platform_accounts FOR INSERT WITH CHECK (true);
CREATE POLICY "Anyone can update platform_accounts" ON public.platform_accounts FOR UPDATE USING (true);
CREATE POLICY "Anyone can delete platform_accounts" ON public.platform_accounts FOR DELETE USING (true);

-- Add account_id to upload_jobs
ALTER TABLE public.upload_jobs ADD COLUMN account_id UUID REFERENCES public.platform_accounts(id) ON DELETE SET NULL;

-- Add account_id to scheduled_uploads
ALTER TABLE public.scheduled_uploads ADD COLUMN account_id UUID REFERENCES public.platform_accounts(id) ON DELETE SET NULL;

-- Migrate existing credentials from app_settings into platform_accounts
INSERT INTO public.platform_accounts (platform, label, email, password, enabled, is_default)
SELECT 'youtube', 'Main', youtube_email, youtube_password, youtube_enabled, true
FROM public.app_settings WHERE youtube_email <> '' LIMIT 1;

INSERT INTO public.platform_accounts (platform, label, email, password, enabled, is_default)
SELECT 'tiktok', 'Main', tiktok_email, tiktok_password, tiktok_enabled, true
FROM public.app_settings WHERE tiktok_email <> '' LIMIT 1;

INSERT INTO public.platform_accounts (platform, label, email, password, enabled, is_default)
SELECT 'instagram', 'Main', instagram_email, instagram_password, instagram_enabled, true
FROM public.app_settings WHERE instagram_email <> '' LIMIT 1;
