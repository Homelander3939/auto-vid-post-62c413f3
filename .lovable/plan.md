

## Plan: AI-Powered Social Media Post Manager

Adds a new feature alongside the existing video upload system: scheduling and publishing image/text posts to **X (Twitter)**, **TikTok**, and **Facebook**, with optional AI generation of the post content (description + media research).

### 1. New Settings Section: Social Post Accounts

Mirrors the existing multi-account pattern in `SettingsPage.tsx`:
- New card group: "Social Post Accounts" with three sub-cards (X, TikTok, Facebook)
- Each platform supports multiple accounts (label, email, password, default, enabled)
- Each account has the same **"Prepare Profile"** button — opens a persistent local Chrome profile so the user logs in once and the saved session is reused
- New AI section: "Post Generator AI" — input for **LLM provider** (OpenAI / OpenRouter / Anthropic / Lovable AI default) and an **API key** field stored in `app_settings`

### 2. Database Changes

| Table | Purpose |
|-------|---------|
| `social_post_accounts` | Same shape as `platform_accounts` but `platform` ∈ `x`, `tiktok`, `facebook` |
| `social_posts` | Manual/AI posts: `id, description, image_path, hashtags[], target_platforms[], status, scheduled_at, account_selections jsonb, ai_prompt, created_at, completed_at, platform_results jsonb` |
| `social_post_schedules` | Recurring schedules (folder/AI-driven), same shape as `schedule_config` but for posts |
| `app_settings` | Add `ai_provider text`, `ai_api_key text`, `ai_model text` |

Storage bucket `social-media` (public) for uploaded/AI-generated images.

### 3. New UI Pages / Components

- **`src/pages/SocialPosts.tsx`** — new nav entry "Social Posts" with two tabs:
  - **Compose**: description textarea, image upload, hashtag input, platform/account picker (reuses `AccountPicker`), "Schedule" or "Post Now" buttons, plus an **"AI Generate"** panel
  - **Queue**: list of pending/completed posts (mirrors `UploadQueue`)
- **`src/components/AIPostComposer.tsx`** — prompt box, "Generate" button, preview of returned description + suggested image, "Use this" / "Regenerate" actions
- **`src/components/SocialPostScheduler.tsx`** — recurring schedule (interval/cron) for AI-driven daily posts
- Reuse existing `AccountPicker`, `localBrowserProfiles.ts` helpers

### 4. AI Generation Edge Function

`supabase/functions/generate-social-post/index.ts`:
- Input: `{ prompt, platforms[], accountSelections, includeImage }`
- Uses configured LLM (defaults to **Lovable AI Gateway** with `google/gemini-3-flash-preview` if no custom key)
- Steps:
  1. Web research via existing **Firecrawl** connector OR Lovable AI web-search-style prompt
  2. Generate platform-tuned description + integrated hashtags (X ≤ 280 chars, TT/FB longer)
  3. If `includeImage`: call `google/gemini-3.1-flash-image-preview` to generate an image, upload to `social-media` bucket, return public URL
- Returns `{ description, hashtags, imageUrl, sources[] }`
- If user provided their own LLM API key in settings, route to that provider instead

### 5. Local Worker — Posting Uploaders

New files in `server/uploaders/`:
- `x.js` — opens persistent Chrome profile, navigates to x.com compose, attaches image, types description, clicks Post
- `tiktok-post.js` — TikTok photo post flow (Studio "Upload" → Photo mode)
- `facebook.js` — facebook.com new post flow with image attachment

All three:
- Use `resolveUserDataDir(accountId, browserProfileId)` from existing browser-profile module — exact same shared-profile logic as YouTube/TikTok video uploaders
- Read credentials via `loadJobAccountContext()` so the per-platform account picker works identically
- Telegram notifications follow the existing strategy (only obstacles + final summary)

New `server/socialPostProcessor.js`:
- Polls `social_posts` table for `pending` + due `scheduled_at`
- Downloads image from Supabase Storage to `/tmp`
- Dispatches to the right uploader per platform
- Updates `platform_results` with URL or error

New endpoints in `server/index.js`:
- `POST /api/social-posts/process/:id` — immediate trigger (5s polling like video jobs)
- Reuses existing `/api/browser-profiles/open` for "Prepare Profile" on social accounts (just pass platform `x` / `facebook` / `tiktok-post`)

### 6. Storage Layer (`src/lib/storage.ts`)

New functions:
- `getSocialAccounts() / saveSocialAccount() / deleteSocialAccount()`
- `createSocialPost({ description, imageFile, hashtags, platforms, accountSelections, scheduledAt? })`
- `listSocialPosts() / deleteSocialPost()`
- `generatePostWithAI(prompt, options)` — invokes the edge function

Image upload helper: uploads to `social-media` bucket, stores public path on the post row.

### 7. Files Modified / Created

**Created**
- Migration SQL (tables + bucket + RLS)
- `src/pages/SocialPosts.tsx`
- `src/components/AIPostComposer.tsx`
- `src/components/SocialPostScheduler.tsx`
- `src/components/SocialAccountCard.tsx` (reuses pattern from `PlatformAccountCard`)
- `supabase/functions/generate-social-post/index.ts`
- `server/uploaders/x.js`, `server/uploaders/tiktok-post.js`, `server/uploaders/facebook.js`
- `server/socialPostProcessor.js`

**Modified**
- `src/pages/SettingsPage.tsx` — add Social Post Accounts section + AI provider config
- `src/lib/storage.ts` — new CRUD + AI invoke
- `src/components/AppLayout.tsx` — add "Social Posts" nav link
- `src/App.tsx` — register new route
- `server/index.js` — register social-post processor + endpoints, extend browser-profile open to support new platforms

### What Does NOT Change

- Video upload flow, YouTube/TikTok/Instagram video uploaders — untouched
- Existing browser profile system — extended, not replaced (same shared-profile sessions)
- Telegram notification rules — same (errors + final summary only)
- Scheduling timezone (Tbilisi GET) — same

