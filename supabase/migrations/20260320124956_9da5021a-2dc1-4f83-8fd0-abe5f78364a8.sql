ALTER TABLE public.telegram_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.telegram_bot_state ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'telegram_messages'
      AND policyname = 'Public can read telegram messages'
  ) THEN
    CREATE POLICY "Public can read telegram messages"
      ON public.telegram_messages
      FOR SELECT
      USING (true);
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'telegram_bot_state'
      AND policyname = 'Public can read telegram bot state'
  ) THEN
    CREATE POLICY "Public can read telegram bot state"
      ON public.telegram_bot_state
      FOR SELECT
      USING (true);
  END IF;
END
$$;