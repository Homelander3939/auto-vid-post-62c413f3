---
name: Multi-Account Platform Support
description: Multiple accounts per platform (YouTube, TikTok, Instagram) with account picker during upload/scheduling
type: feature
---
- `platform_accounts` table stores multiple accounts per platform with label, email, password, enabled, is_default
- `upload_jobs` and `scheduled_uploads` have nullable `account_id` FK to `platform_accounts`
- Settings page uses `PlatformAccountCard` component for CRUD per platform
- Dashboard and CampaignScheduler show `AccountPicker` dropdown when a platform has >1 enabled account
- Server resolves credentials: account_id lookup → fallback to app_settings
- Existing single-account data was migrated to platform_accounts as default accounts
- `useAccountsForPlatforms` hook provides account state management
