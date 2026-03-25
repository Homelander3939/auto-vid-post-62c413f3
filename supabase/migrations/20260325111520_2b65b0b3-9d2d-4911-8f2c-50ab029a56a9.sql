CREATE TABLE public.pending_commands (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  command TEXT NOT NULL,
  args JSONB DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',
  result TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  completed_at TIMESTAMP WITH TIME ZONE
);

-- Allow anonymous access since this app has no auth
ALTER TABLE public.pending_commands ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all access to pending_commands"
  ON public.pending_commands
  FOR ALL
  TO anon, authenticated
  USING (true)
  WITH CHECK (true);