
Goal: make local mode the primary autonomous uploader (no platform API credentials), keep Telegram/AI as helper only, and make cross-platform browser automation reliable.

What I found (root cause)
- Your screenshot error is real and reproducible from code: `process-uploads` still has a local-mode branch that tries YouTube/TikTok/Instagram API uploads and throws “API credentials not configured”.
- This function is also invoked every minute by backend cron, so even in local mode it keeps trying the wrong path.
- Dashboard always invokes `process-uploads` after queuing, regardless of mode.
- Local status indicator checks `http://localhost:3001/health`, but the server exposes `/api/health` (so UI can show local server as offline even when it’s running).
- Do I know what the issue is? Yes.

Implementation plan

1) Enforce strict mode separation (local never uses API uploader path)
- Update `supabase/functions/process-uploads/index.ts`:
  - If `upload_mode === 'local'`, return early with a clear no-op result (do not process pending jobs, do not call API upload helpers).
  - Keep cloud processing only when `upload_mode === 'cloud'`.
  - Remove/retire misleading API-credential upload code paths and messages for local flow.
- Result: no more “YouTube API credentials” failures when local mode is selected, even with cron active.

2) Trigger the correct executor from UI
- Update `src/pages/Dashboard.tsx`:
  - Read settings before triggering processing.
  - Cloud mode: invoke backend cloud processor.
  - Local mode: call local server endpoint (`/api/process-pending`) to start immediate local processing (best-effort; fallback to cron polling).
- Update local server endpoint behavior in `server/index.js`:
  - Make `/api/process-pending` non-blocking (start processing and return quickly).
  - Prevent duplicate processing via atomic claim (only process jobs still `pending` at claim time).

3) Prevent accidental platform selection mistakes
- Update Dashboard + Campaign scheduler platform selectors:
  - Pre-compute “ready platforms” = enabled + credentials present.
  - Disable or auto-unselect platforms not ready, with explicit UI hint.
  - Block queue/schedule action when selected platform set contains unready entries.
- Keep server-side validation as final guardrail (authoritative).

4) Fix scheduled folder uploads to work as intended in local mode
- Keep backward compatibility with current format (`[folder] <path>` in `video_file_name`).
- Update `server/index.js` scheduled flow:
  - Detect folder-source entries.
  - At execution time, scan that folder for latest video + optional `.txt` metadata.
  - Create upload job with resolved file/metadata and chosen platforms.
  - If nothing found, mark scheduled row error with clear reason.
- This delivers your requested behavior: planned uploads use chosen local folder files automatically.

5) Make local browser agent smarter across all platforms
- Refactor `server/uploaders/*` + `server/uploaders/smart-agent.js` into deterministic-first playbooks (YouTube/TikTok/Instagram), with AI/DOM fallback only when signals are ambiguous.
- Add robust stuck-handling:
  - state confirmation after each action,
  - bounded retries with alternative selectors/actions,
  - direct fallback navigation when upload entry points are not found.
- Keep session persistence and manual first-login support, but improve autonomous continuation after login.

6) Telegram behavior: only obstacle + final result, with visual evidence
- Keep notification policy strict:
  - send only when human intervention is required (verification/blocker),
  - and final summary (success/failed/partial).
- Add obstacle screenshots:
  - capture screenshot on verification/blocker,
  - upload to storage,
  - send via Telegram photo/link immediately with concise instruction.
- No noisy “every step” messages.

7) Status correctness hardening
- Normalize status lifecycle across local/cloud workers.
- Add DB update error checks everywhere (don’t ignore update failures).
- Update `upload_jobs` status constraint via migration to match used statuses (include `uploading`/`partial` if retained), or unify code to a smaller allowed set.
- Add stale-job reconciliation to local worker too (not only cloud function), so jobs don’t stay misleadingly active.

Technical details (files to touch)
- Backend function: `supabase/functions/process-uploads/index.ts`
- Local worker: `server/index.js`, `server/uploaders/youtube.js`, `server/uploaders/tiktok.js`, `server/uploaders/instagram.js`, `server/uploaders/smart-agent.js`, `server/uploaders/approval.js`, `server/telegram.js`
- Frontend: `src/pages/Dashboard.tsx`, `src/components/CampaignScheduler.tsx`, `src/components/AppLayout.tsx` (health endpoint fix)
- Storage/types layer (if needed for local trigger helpers): `src/lib/storage.ts`
- Migration(s): upload status constraint alignment (and only if needed for chosen status model)

Validation checklist after implementation
- Local mode + YouTube credentials only: queue upload → no API credential error, only YouTube runs.
- Local mode + scheduled folder entry: due time resolves actual local file and uploads.
- Obstacle case (2FA): Telegram receives intervention request + screenshot; no false obstacle spam.
- Completion case: Telegram gets exactly one final summary with per-platform outcomes.
- Cloud mode still works independently and does not conflict with local worker.
