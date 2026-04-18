-- Cancel current stuck jobs
UPDATE public.generation_jobs
SET status = 'cancelled',
    error = COALESCE(error, 'Cancelled — stuck job recovery'),
    completed_at = now(),
    updated_at = now()
WHERE status = 'running';

-- Helper function: cancel any stale running jobs (>10 min old)
CREATE OR REPLACE FUNCTION public.cancel_stale_generation_jobs()
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.generation_jobs
  SET status = 'cancelled',
      error = COALESCE(error, 'Auto-cancelled: exceeded 10 minute runtime'),
      completed_at = now(),
      updated_at = now()
  WHERE status = 'running'
    AND created_at < now() - interval '10 minutes';
$$;