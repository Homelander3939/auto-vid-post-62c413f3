
-- Scheduled uploads table: each row is a pre-uploaded video+text pair with a scheduled publish time
CREATE TABLE public.scheduled_uploads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  video_file_name text NOT NULL,
  video_storage_path text,
  title text NOT NULL DEFAULT '',
  description text NOT NULL DEFAULT '',
  tags text[] NOT NULL DEFAULT '{}',
  target_platforms text[] NOT NULL DEFAULT '{youtube,tiktok,instagram}',
  scheduled_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'scheduled',
  upload_job_id uuid REFERENCES public.upload_jobs(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.scheduled_uploads ENABLE ROW LEVEL SECURITY;

-- Public access policies (same pattern as other tables - no auth required for this personal tool)
CREATE POLICY "Anyone can read scheduled_uploads" ON public.scheduled_uploads FOR SELECT TO public USING (true);
CREATE POLICY "Anyone can insert scheduled_uploads" ON public.scheduled_uploads FOR INSERT TO public WITH CHECK (true);
CREATE POLICY "Anyone can update scheduled_uploads" ON public.scheduled_uploads FOR UPDATE TO public USING (true);
CREATE POLICY "Anyone can delete scheduled_uploads" ON public.scheduled_uploads FOR DELETE TO public USING (true);
