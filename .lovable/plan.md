## Goal

Make the local server actively watch upload folders for newly-arrived `video + .txt` pairs, queue them as upload jobs automatically, and once a job completes successfully on **all** target social platforms (and the Telegram summary is sent), delete the video and its matching `.txt` from disk so the folder stays clean.

## Behavior

1. **New-file detection (auto upload on arrival)**
   - The server watches every folder currently in use:
     - `app_settings.folder_path` (the global default folder)
     - Every `schedule_config.folder_path` of an enabled recurring schedule
     - Every campaign-folder path referenced by pending `scheduled_uploads` rows
   - Detection runs every ~15 seconds (lightweight `scanAllFiles` poll — same logic already used; no new dependencies).
   - A file is treated as "new and ready" only when:
     - It has both a video (`.mp4/.mov/.avi/.mkv/.webm`) and a matching-stem `.txt`
     - Both files have been stable for ≥ 30 seconds (size unchanged between two polls) — prevents picking up partially-downloaded files
     - It hasn't already been queued (tracked in a small JSON state file `server/data/folder-watch-state.json` keyed by absolute path)
   - When ready, the server creates an `upload_jobs` row using the existing `[folder|<intensity>] <path>` convention so the existing worker picks it up immediately. Platforms / accounts are inherited from the matching schedule (or app defaults if it's the global folder).

2. **Auto-delete after fully successful upload**
   - After the existing worker finishes a job and writes `status = 'completed'` (i.e. **every** target platform reported `success`) AND the Telegram summary has been sent, the worker deletes:
     - The video file
     - The matching `.txt` file (same stem, same folder)
   - If the job ends as `partial` or `failed`, **nothing is deleted** — files stay so the user can retry.
   - Storage-backed jobs (videos uploaded via the web UI to Supabase Storage) are unaffected — only local-folder files are deleted.
   - A new opt-in setting **"Delete source files after successful upload"** is added to Settings (default: ON, since this matches the user's stated workflow). When OFF, files are kept regardless.

3. **Telegram notice**
   - The existing success summary message is extended with one extra line when files were deleted, e.g.:
     `🧹 Cleaned up: video.mp4 + video.txt`

## Technical changes

- **DB migration** — add column `app_settings.delete_after_upload boolean not null default true`.
- **`server/folderWatcher.js`** — add `getReadyPairs(folderPath, stateMap)` that returns only pairs which (a) have matching `.txt`, (b) are size-stable since last scan, (c) are not in `stateMap.queued`. Persist the state map to `server/data/folder-watch-state.json`.
- **`server/index.js`**
  - Add a `setInterval(15_000)` watcher loop that:
    1. Loads `app_settings`, all enabled `schedule_config` rows, and pending `scheduled_uploads` campaign folders.
    2. For each unique folder, calls `getReadyPairs`. For each ready pair, inserts an `upload_jobs` row with `video_file_name = "[folder|<intensity>] <absPath>"`, the right platforms/accounts, and marks it queued in the state file.
  - In the existing worker (around line 465, right after the success summary), if `finalStatus === 'completed'` and `settings.deleteAfterUpload !== false` and the job is folder-based, delete `videoPath` and the matching `.txt` (resolved via `resolveMetadataForVideo`'s base dir + stem). Append `🧹 Cleaned up: …` line to the Telegram summary.
- **`src/pages/SettingsPage.tsx`** — add a toggle "Delete source files after successful upload" wired to the new `delete_after_upload` column.
- **No edge-function changes**, no new packages.

## Out of scope

- Uploading to cloud storage before deleting (files are gone after successful local upload — same as the user's described workflow).
- Recovering from manually-deleted folders mid-job.
- Watching folders that aren't referenced by any setting/schedule/campaign.
