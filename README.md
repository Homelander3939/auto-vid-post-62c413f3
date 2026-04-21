# Video Uploader App

Automated video uploader for YouTube, TikTok, and Instagram with Telegram notifications and AI-powered browser automation.

## Architecture

```
┌──────────────────────────────────┐
│  React Frontend (Vite, :8081)    │  ← Works online AND locally
│  - Upload video + text file      │
│  - Configure platform creds      │
│  - Upload queue with status      │
│  - Schedule configuration        │
│  - Campaign scheduling           │
└──────────┬───────────────────────┘
           │ Lovable Cloud (database + file storage)
┌──────────▼───────────────────────┐
│  Local Node.js Server (:3001)    │  ← Only when running locally
│  - Downloads video from storage  │
│  - Playwright browser automation │
│  - Uploads to YouTube/TikTok/IG  │
│  - Sends Telegram notifications  │
│  - Cron scheduler for auto-runs  │
│  - AI-powered obstacle handling  │
└──────────────────────────────────┘
```

## Quick Start (Windows)

### One-Click Launcher

1. Clone the repo to `C:\auto-vid-post`
2. Double-click **`smart-launcher.bat`**

That's it! The launcher will:
- Pull latest updates from GitHub
- Verify frontend dependencies after pulling updates and install any missing or outdated packages
- Install server dependencies if missing (including Playwright browser)
- Start the backend server and frontend
- Open Brave Browser (or default browser) at `http://localhost:8081`

### Manual Setup

#### 1. Clone and install

```bash
git clone <your-repo-url> C:\auto-vid-post
cd C:\auto-vid-post
npm install
```

#### 2. Install server dependencies

```bash
cd server
npm install
npx playwright install chromium
cd ..
```

#### 3. Start the app

**Terminal 1 — Frontend:**
```bash
npm run dev -- --port 8081 --strictPort
```

**Terminal 2 — Local Server:**
```bash
cd server
npm start
```

#### 4. Open `http://localhost:8081`

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
4. **Local server processes** — Downloads video, opens Playwright browser, logs into platforms, uploads
5. **Telegram notification** — Success link or error sent to your bot
6. **AI obstacle handling** — If login verification or CAPTCHA appears, the system screenshots and sends to Telegram for your input

## Scheduled Uploads

### Recurring Schedules
- Set up daily/hourly/weekly recurring uploads from the Schedule page
- Point to a local folder — the system auto-picks the latest video + text file
- Only platforms with valid credentials are used
- Set duration limits (days/hours/weeks)

### Campaign Scheduling
- Plan individual uploads for specific dates and times
- Upload video + text file per entry with precise scheduling
- Scheduled jobs appear in Upload Queue as "upcoming" before their time

## Telegram Bot Setup

1. Message [@BotFather](https://t.me/BotFather) → `/newbot`
2. Copy the bot token
3. Message your bot, visit `https://api.telegram.org/bot<TOKEN>/getUpdates` for chat ID
4. Enter both in Settings

### Telegram AI Features
- Send text/voice/image messages to your bot for AI assistance
- Get real-time upload status and obstacle screenshots
- Reply with authentication codes when platforms request verification
- Voice messages are transcribed and understood

## Important Notes

- **Browser automation is fragile** — Platform UI changes can break upload scripts
- **First login** — Browser opens visibly for 2FA/captcha
- **Sessions persist** in `server/data/browser-sessions/`
- **All data** is stored in the cloud database — works from any device
- **Smart obstacle handling** — System detects verification prompts and collaborates with you via Telegram
- **Platform-aware scheduling** — Only uploads to platforms where credentials are configured
