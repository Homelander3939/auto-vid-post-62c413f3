-- Add ai_base_url column so LM Studio (and other OpenAI-compatible) base URLs
-- are persisted alongside the other AI provider settings.
ALTER TABLE public.app_settings
  ADD COLUMN IF NOT EXISTS ai_base_url text NOT NULL DEFAULT '';
