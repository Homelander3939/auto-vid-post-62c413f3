# Video Uploader App

Automated video uploader for YouTube, TikTok, and Instagram with Telegram notifications.

## How It Works

- **React Frontend** (port 8080) — Dashboard, settings, upload queue, scheduling
- **Node.js Server** (port 3001) — Reads local folder, automates browser uploads via Playwright

## Setup Instructions (Windows)

### 1. Clone and install frontend

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

Open **two terminals**:

**Terminal 1 — Frontend:**
```bash
npm run dev
```

**Terminal 2 — Server:**
```bash
cd server
npm start
```

### 4. Open the app

Go to `http://localhost:8080` in your browser.

## Configuration

### Settings Page

1. **Folder Path** — Set the Windows folder path where you place videos (e.g., `C:\Users\You\Videos\uploads`)
2. **Platform Credentials** — Enable and enter login credentials for YouTube, TikTok, Instagram
3. **Telegram** — Enter your bot token and chat ID for notifications

### Text File Format

Place a `.txt` file alongside your video in the folder:

```
Title: My Video Title
Description: This is the video description
Tags: tag1, tag2, tag3
Platforms: youtube, tiktok, instagram
```

### Supported Video Formats

`.mp4`, `.mov`, `.avi`, `.mkv`, `.webm`

## Usage

1. Place a video file and `.txt` file in your configured folder
2. Open the Dashboard — files are auto-detected
3. Select platforms and click "Start Upload"
4. Monitor progress in the Upload Queue
5. Set up scheduled uploads in the Schedule page

## How Upload Works

- Playwright opens a real Chromium browser window
- First time: you'll see the login flow (credentials auto-filled)
- Sessions persist — subsequent uploads won't need re-login
- Telegram sends you the upload link or error message

## Telegram Bot Setup

1. Message [@BotFather](https://t.me/BotFather) on Telegram
2. Send `/newbot` and follow instructions
3. Copy the bot token
4. Message your bot, then visit `https://api.telegram.org/bot<TOKEN>/getUpdates` to find your chat ID
5. Enter both in Settings

## Important Notes

- **Browser automation is fragile** — Platform UI changes may break upload scripts
- **First login** — The browser will open visibly for you to complete any 2FA/captcha
- **Sessions persist** in `server/data/browser-sessions/`
- **Credentials stored locally** in `server/data/settings.json` — never uploaded anywhere
