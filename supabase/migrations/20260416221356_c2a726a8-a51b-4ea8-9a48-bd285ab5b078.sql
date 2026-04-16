ALTER TABLE public.app_settings
  ADD COLUMN IF NOT EXISTS research_provider text NOT NULL DEFAULT 'auto',
  ADD COLUMN IF NOT EXISTS research_api_key  text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS image_provider    text NOT NULL DEFAULT 'auto',
  ADD COLUMN IF NOT EXISTS image_api_key     text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS image_secondary_key text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS research_depth    text NOT NULL DEFAULT 'standard',
  ADD COLUMN IF NOT EXISTS local_agent_url   text NOT NULL DEFAULT 'http://localhost:3001';