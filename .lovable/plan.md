

# Video Uploader App — Plan

## Architecture

The app has two parts that run locally on your PC:

```text
┌─────────────────────────────────┐
│  React Frontend (Vite, :8080)   │  ← I build this in Lovable
│  - Configure folder path        │
│  - Platform credentials setup   │
│  - Upload queue & status        │
│  - Scheduled upload management  │
└──────────┬──────────────────────┘
           │ HTTP API calls
┌──────────▼──────────────────────┐
│  Local Node.js Server (:3001)   │  ← I create these files too
│  - Read folder (video + .txt)   │
│  - Parse text file for metadata │
│  - Launch Playwright browser    │
│  - Automate YouTube Studio      │
│  - Automate TikTok Creator      │
│  - Automate Instagram Creator   │
│  - Send Telegram notifications  │
│  - Cron scheduler for retries   │
└─────────────────────────────────┘
```

You pull from GitHub, run `npm install && npm start`, open `localhost:8080`.

## What I Build (React Frontend)

1. **Settings Page** — Configure: local folder path, YouTube/TikTok/Instagram credentials, Telegram bot token + chat ID
2. **Dashboard** — Shows detected video + text file from folder, parsed metadata preview (title, description, tags), upload status per platform
3. **Upload Queue** — Trigger uploads, view progress/errors, retry failed uploads
4. **Schedule Page** — Set cron schedule for auto-uploads, view scheduled jobs

## What I Build (Local Server — `server/` directory)

1. **Folder watcher** — Reads specified folder, finds latest `.mp4`/`.mov` and `.txt` file
2. **Text parser** — Extracts title, description, hashtags/keywords from text file (configurable format)
3. **Playwright automation scripts** for each platform:
   - YouTube Studio: login, upload video, fill title/description/tags, publish
   - TikTok: login, upload video, fill details, post
   - Instagram: login, upload reel, fill caption, share
4. **Telegram notifier** — Sends success link or error message to your bot
5. **Cron scheduler** — node-cron for scheduled/retry uploads
6. **Express API** — endpoints the frontend calls

## Limitations to Know

- **Browser automation is fragile**: Platform UI changes can break scripts. YouTube is most reliable; TikTok and Instagram change frequently.
- **Login sessions**: Playwright will use a persistent browser context so you only log in once manually, then sessions persist.
- **The server files I create won't run in Lovable preview** — they only work when you clone and run locally.

## Implementation Steps

1. Build the React frontend (settings, dashboard, queue, schedule pages)
2. Create `server/` directory with Express server, folder reader, text parser
3. Create Playwright automation scripts for YouTube, TikTok, Instagram
4. Add Telegram notification module
5. Add cron scheduling with node-cron
6. Add `package.json` scripts and setup instructions in README

## Text File Format (Default)

```text
Title: My Video Title
Description: Video description here
Tags: tag1, tag2, tag3
Platforms: youtube, tiktok, instagram
```

