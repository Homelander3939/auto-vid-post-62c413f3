-- pending_commands: allows edge functions (Telegram bot) to queue stats checks
-- that the local server processes asynchronously. Solves the localhost unreachable problem.
CREATE TABLE IF NOT EXISTS public.pending_commands (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  command TEXT NOT NULL,
  args JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  result TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

ALTER TABLE public.pending_commands ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read pending_commands" ON public.pending_commands FOR SELECT USING (true);
CREATE POLICY "Anyone can insert pending_commands" ON public.pending_commands FOR INSERT WITH CHECK (true);
CREATE POLICY "Anyone can update pending_commands" ON public.pending_commands FOR UPDATE USING (true);
CREATE POLICY "Anyone can delete pending_commands" ON public.pending_commands FOR DELETE USING (true);
