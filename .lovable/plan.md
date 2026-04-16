

## Plan: Multi-Account Support Per Platform

### What Changes

Currently each platform (YouTube, TikTok, Instagram) supports exactly one account stored in the `app_settings` table. This plan adds support for multiple accounts per platform, with account selection during upload/scheduling.

### Database Changes

**New table: `platform_accounts`**

| Column | Type | Notes |
|--------|------|-------|
| id | uuid (PK) | Auto-generated |
| platform | text | `youtube`, `tiktok`, `instagram` |
| label | text | User-friendly name (e.g. "Main Channel", "Gaming") |
| email | text | Login email |
| password | text | Login password |
| enabled | boolean | Default true |
| is_default | boolean | Default false — one default per platform |
| created_at | timestamptz | |

RLS: public read/insert/update/delete (matches existing app_settings pattern).

**Modify `upload_jobs`**: Add `account_id uuid` nullable column — links job to specific account.

**Modify `scheduled_uploads`**: Add `account_id uuid` nullable column.

The existing `app_settings` platform columns (youtube_email, etc.) will remain for backward compatibility but the system will prefer `platform_accounts` when present.

### Migration of Existing Data

An SQL migration will copy any existing non-empty credentials from `app_settings` into `platform_accounts` as the default account for each platform, so nothing is lost.

### Settings Page (`src/pages/SettingsPage.tsx`)

Replace the single email/password card per platform with a multi-account card:
- Each platform card shows a list of saved accounts (label, email, default badge)
- "Add Account" button opens inline fields for label, email, password
- Each account row has edit/delete actions and a "Set Default" toggle
- The enabled/disabled toggle moves to the account level
- Clean, compact design — accounts shown as a list with minimal chrome

### Dashboard (`src/pages/Dashboard.tsx`)

- When a selected platform has multiple enabled accounts, show an account picker dropdown below the platform buttons
- Default account is pre-selected
- Single account = no picker shown (seamless, no UI clutter)
- Account selection stored per-platform in state, passed to `createUploadJob`

### Campaign Scheduler (`src/components/CampaignScheduler.tsx`)

- Same account picker pattern as Dashboard when multiple accounts exist

### Storage Layer (`src/lib/storage.ts`)

- New CRUD functions: `getPlatformAccounts()`, `savePlatformAccount()`, `deletePlatformAccount()`
- `createUploadJob` and `createScheduledUpload` accept optional `accountId` parameter
- `AppSettings` interface extended but kept backward-compatible
- `getPlatformStatuses` updated to check `platform_accounts` table

### Server (`server/index.js`)

- `getSettings()` updated to also fetch `platform_accounts`
- `processJob()` reads `account_id` from the job row, looks up the matching account credentials
- Falls back to `app_settings` credentials if no `account_id` (backward compat)
- Uploaders receive the resolved credentials as before — no changes to youtube.js, tiktok.js, instagram.js

### Files Modified

1. **Migration SQL** — Create `platform_accounts` table, add `account_id` to `upload_jobs` and `scheduled_uploads`, migrate existing data
2. **`src/lib/storage.ts`** — New account CRUD, updated job creation
3. **`src/pages/SettingsPage.tsx`** — Multi-account UI per platform
4. **`src/pages/Dashboard.tsx`** — Account picker when multiple accounts
5. **`src/components/CampaignScheduler.tsx`** — Account picker
6. **`server/index.js`** — Read account_id from jobs, resolve credentials

### What Does NOT Change

- Upload logic in youtube.js, tiktok.js, instagram.js — unchanged
- Telegram notifications — unchanged
- Schedule configs — unchanged
- Folder watcher — unchanged
- All existing single-account setups continue working without any user action

