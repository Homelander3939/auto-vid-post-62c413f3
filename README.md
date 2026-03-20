# Video Uploader App

Automated video uploader for YouTube, TikTok, and Instagram with Telegram notifications.

## Architecture

```
┌──────────────────────────────────┐
│  React Frontend (Vite, :8080)    │  ← Works online AND locally
│  - Upload video + text file      │
│  - Configure platform creds      │
│  - Upload queue with status      │
│  - Schedule configuration        │
└──────────┬───────────────────────┘
           │ Supabase (database + file storage)
┌──────────▼───────────────────────┐
│  Local Node.js Server (:3001)    │  ← Only when running locally
│  - Downloads video from storage  │
│  - Playwright browser automation │
│  - Uploads to YouTube/TikTok/IG  │
│  - Sends Telegram notifications  │
│  - Cron scheduler for auto-runs  │
└──────────────────────────────────┘
```

## Online Mode (Lovable Preview)

The app works fully online — you can:
- Upload video and text files (stored in cloud)
- Configure all settings (saved to database)
- Create upload jobs and see simulated progress
- Set up schedules

Actual platform uploads only happen via the local server.

## Local Setup (Windows)

### 1. Clone and install

```bash
git clone <your-repo-url>
cd <project-folder>
npm install
```

### 2. Install server dependencies

```bash
cd server
npm install
npx playwright install chromium
cd ..
```

### 3. Start the app

**Terminal 1 — Frontend:**
```bash
npm run dev
```

**Terminal 2 — Local Server:**
```bash
cd server
npm start
```

### 4. Open `http://localhost:8080`

## How It Works

1. **Upload files** — Select video (.mp4, .mov) and text (.txt) on the Dashboard
2. **Text file format:**
   ```
   Title: My Video Title
   Description: This is the description
   Tags: tag1, tag2, tag3
   Platforms: youtube, tiktok, instagram
   ```
3. **Click "Start Upload"** — Video is stored in cloud, job is queued
4. **Local server processes** — Downloads video, opens Playwright browser, uploads to each platform
5. **Telegram notification** — Success link or error sent to your bot

## Telegram Bot Setup

1. Message [@BotFather](https://t.me/BotFather) → `/newbot`
2. Copy the bot token
3. Message your bot, visit `https://api.telegram.org/bot<TOKEN>/getUpdates` for chat ID
4. Enter both in Settings

## Important Notes

- **Browser automation is fragile** — Platform UI changes can break upload scripts
- **First login** — Browser opens visibly for 2FA/captcha
- **Sessions persist** in `server/data/browser-sessions/`
- **All data** is stored in the cloud database — works from any device
