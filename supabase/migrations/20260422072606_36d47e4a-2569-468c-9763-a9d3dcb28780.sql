-- 1. Sanitize bad saved AI model when provider is lovable
UPDATE public.app_settings
SET ai_model = 'google/gemini-3-flash-preview'
WHERE id = 1
  AND COALESCE(ai_provider, 'lovable') = 'lovable'
  AND ai_model NOT IN (
    'google/gemini-3-flash-preview',
    'google/gemini-3.1-pro-preview',
    'google/gemini-2.5-pro',
    'google/gemini-2.5-flash',
    'google/gemini-2.5-flash-lite',
    'openai/gpt-5',
    'openai/gpt-5-mini',
    'openai/gpt-5-nano',
    'openai/gpt-5.2'
  );

-- 2. Track resolved chat config + diagnostics on agent runs
ALTER TABLE public.agent_runs
  ADD COLUMN IF NOT EXISTS chat_settings jsonb;

-- 3. Tighten app_settings SELECT to authenticated users only.
-- Service role (backend edge functions) bypasses RLS so backend logic still works.
DROP POLICY IF EXISTS "Anyone can read settings" ON public.app_settings;
CREATE POLICY "Authenticated can read settings"
  ON public.app_settings
  FOR SELECT
  TO authenticated
  USING (true);
