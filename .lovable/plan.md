## Goal

When a saved Chrome profile is silently logged out, the app currently freezes or skips uploads. Make all three uploaders self-recover: notify on Telegram, then proceed through full login (email → password → 2FA) with smart screen detection. Do NOT change behavior when the profile is already logged in and uploads work normally.

## Scope of changes (server-side only, no UI logic changes besides one new optional field)

### 1. YouTube — handle "logged-out profile" + phone/number-match verification

File: `server/uploaders/youtube.js` (login loop around lines 940–1120) and `server/uploaders/approval.js`.

- **Detect logged-out profile early.** When the studio URL redirects to `accounts.google.com` and the loop starts, send a single Telegram notification: *"⚠️ YouTube Chrome profile is logged out — auto-logging in as <email>"*. Do NOT throw; continue the loop.
- **"Confirm your recovery phone number" screen** (the one in the screenshot pattern: "ending in •• 42"):
  - Add detection in `inspectGoogleAuthState` for: text contains `confirm your recovery phone`, `enter the phone number`, `to continue`, or visible `input[type="tel"]` with placeholder asking for full number.
  - Read the partial mask shown by Google (e.g. `•• 42`). Pull the matching full number from the account's new `recovery_phone` field (added below). If the last 2 digits match (`42`), auto-fill `598574742` (or whatever number is stored) and click Next.
  - If multiple "ends in XX" options are listed as radio choices, click the option whose text ends with the last 2 digits of the stored number.
- **"Tap YES on your phone / a text was sent to your number" screens:** Send Telegram message *"📱 Google sent a verification request to your phone (•• 42). Approve it on your device, or reply CODE 123456."* Wait via existing `requestTelegramApproval`. When the user replies with digits, fill the SMS code into `input[type="tel"]`.
- Replace the existing "Login did not complete" hard-throw with a final Telegram failure notification + the existing throw, so Telegram always gets the reason.

### 2. TikTok — recover from "Something went wrong / Retry"

File: `server/uploaders/tiktok.js`.

- After login, before/while waiting for the file input, run a check every iteration:
  - If page text contains "Something went wrong" AND a "Retry" button is visible, OR if no `input[type=file]` appears within ~15s on the studio upload page, then:
    1. Open a brand-new tab via `context.newPage()`.
    2. Navigate it directly to `https://www.tiktok.com/tiktokstudio/upload?from=upload` (and fall back to `creator-center/upload`).
    3. Close the broken tab and continue the upload flow on the new page (replace the `page` reference in scope).
  - Limit recovery attempts to 3 to avoid loops.
- Send a Telegram heads-up only if recovery actually triggered (avoid noise on healthy runs).

### 3. Instagram — actually attempt login + dismiss popups

File: `server/uploaders/instagram.js` (lines 1056–1138).

- Current bug: if Instagram lands on the homepage with the login modal (`/`, not `/accounts/login`), the `if (url.includes('login') || 'accounts'))` branch is skipped and it never fills credentials. Fix:
  - Detect login state by **DOM presence** of `input[name="username"]` (regardless of URL) and run the fill+submit branch when found.
  - If neither logged-in markers nor the username input exist, navigate explicitly to `https://www.instagram.com/accounts/login/` once, then re-check.
- After submitting credentials, dismiss the **"Turn on notifications"** modal in addition to "Save login info":
  - Click any button whose text matches: `not now`, `cancel`, `dismiss`, `skip`, `not right now`.
  - Run that loop 4 times with 1.5s waits to clear stacked modals.
- If Instagram shows the "We sent a code to your email/phone" screen, route to `requestTelegramApproval` exactly like TikTok already does, and on a `CODE 123456` reply, fill `input[name="verificationCode"]`/`input[name="security_code"]` and click Confirm.
- On `Instagram login failed`, send a Telegram error notification before throwing (right now it just throws and the caller already notifies, but include the attempted email + screenshot for context).

### 4. New per-account `recovery_phone` (database + Settings UI minimal addition)

To support the YouTube number flow per account (any future YouTube account uses the same flow with its own number).

- Migration: `ALTER TABLE platform_accounts ADD COLUMN recovery_phone TEXT;`
- Update `src/integrations/supabase/types.ts` typing accordingly.
- Add ONE optional input "Recovery phone (digits only, e.g. 598574742)" in `PlatformAccountCard` — only visible for `platform = 'youtube'`. No other UI changes.
- Server: when fetching credentials for a YouTube job, include `recoveryPhone`. In `youtube.js`, the recovery-phone screen handler uses `credentials.recoveryPhone` (falls back to `598574742` if empty so existing single-account setup keeps working as the user described).

### 5. Shared improvements (small, additive)

- **Approval helper (`server/uploaders/approval.js`):** Already parses `CODE 123456`. Add parsing for a bare number-match reply (e.g. user replies just `42`) and return it as `{ matchDigit: '42' }` so YouTube can pick the right phone option from the list.
- All new Telegram notifications use the existing `sendTelegram` / `sendTelegramPhoto` helpers and respect the project rule of plain-text + only urgent obstacles or final summaries (no chatty mid-run noise unless action is required).

## Out of scope (explicitly NOT touched)

- The happy path where profile is already logged in and uploads succeed.
- Social-post upload flow (Facebook/LinkedIn/X) and the recently-built Upload Post Importer.
- Scheduling, job queue, Browserbase, LM Studio code paths.
- Any frontend besides the single `recovery_phone` field on the YouTube account card.

## Technical summary (for reference)

```
youtube.js
  inspectGoogleAuthState  → add: hasRecoveryPhonePrompt, recoveryPhoneMaskTail, phoneOptionTails[]
  uploadToYouTube login loop:
    on first redirect to accounts.google.com → notify TG once ("profile logged out, auto-logging in")
    on recovery phone screen → fill credentials.recoveryPhone (default 598574742) if mask matches
    on phone-options list      → click option whose tail matches stored number tail
    on "tap YES" / SMS code    → existing requestTelegramApproval, accept CODE / digit replies

tiktok.js
  after navigateToTikTokUpload → if "Something went wrong" or no file input in ~15s:
      const fresh = await context.newPage();
      await fresh.goto(TT_UPLOAD_URL);
      page = fresh; oldPage.close();
  cap recovery to 3 attempts, then notify TG and throw.

instagram.js
  loop: detect input[name=username] regardless of URL → fill creds
        if neither logged-in nor login-form → goto /accounts/login/ once
        dismiss-popups loop adds: "not now", "cancel", "dismiss", "skip"

platform_accounts
  + recovery_phone TEXT (nullable). YouTube card shows it when platform='youtube'.
```

After implementation: restart the local Node worker so the new uploader logic loads.
