DROP POLICY IF EXISTS "Authenticated can read settings" ON public.app_settings;
CREATE POLICY "Anyone can read settings"
  ON public.app_settings
  FOR SELECT
  USING (true);
