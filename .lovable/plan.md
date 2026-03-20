

## Plan: Add AI-Powered Agentic Browser Automation

### Problem
The current cloud browser automation uses hardcoded CSS selectors and rigid step sequences. When platforms change their UI (which happens frequently), the automation breaks. You want intelligent, adaptive automation — like a human would do it.

### Approach
Instead of importing OpenClaw (which is a desktop AI assistant, not embeddable in a web app), we'll build **agentic automation** directly into the existing cloud browser system using two complementary strategies:

1. **Stagehand SDK for local mode** — Browserbase's open-source AI automation framework with `act()`, `extract()`, `observe()` primitives. Runs on the local Node.js server.
2. **AI-driven CDP loop for cloud mode** — An agentic loop in the edge function that takes screenshots, sends them to Lovable AI (vision-capable Gemini), gets back the next action to perform, and executes it via CDP. This replaces all hardcoded selectors.

### Architecture

```text
CLOUD MODE (Edge Function):
┌──────────────┐     ┌─────────────┐     ┌──────────────┐
│ Take Screenshot │──▶│ Lovable AI   │──▶│ Execute Action│
│ via CDP        │   │ (Gemini Pro) │   │ via CDP       │──┐
└──────────────┘     │ "What next?" │   └──────────────┘  │
                     └─────────────┘                       │
                           ▲                               │
                           └───────────────────────────────┘
                                   (loop until done)

LOCAL MODE (Node.js server):
┌──────────────────────────────────────────────┐
│ Stagehand SDK (Browserbase/local Playwright) │
│ stagehand.act("click the upload button")     │
│ stagehand.extract("get the video URL")       │
└──────────────────────────────────────────────┘
```

### Steps

**1. Cloud mode: Build AI agentic loop in edge function**
- Replace `automateYouTube`, `automateTikTok`, `automateInstagram` with a single `agenticUpload()` function
- The loop: take screenshot → send to Gemini with task context → get structured action response (click, type, wait, navigate, done) → execute via CDP → repeat
- AI sees the actual page and decides what to do, no hardcoded selectors
- Keep verification/Telegram approval flow intact
- Use `Page.captureScreenshot` CDP command for screenshots
- Use Lovable AI gateway with `google/gemini-2.5-pro` (vision model) for page analysis

**2. Local mode: Integrate Stagehand SDK**
- Add `@browserbasehq/stagehand` to `server/package.json`
- Replace hardcoded Playwright scripts in `server/uploaders/youtube.js`, `tiktok.js`, `instagram.js` with Stagehand's natural language primitives:
  - `stagehand.act("enter email address")`
  - `stagehand.act("click the upload button")`
  - `stagehand.extract("get the published video URL")`
- Stagehand uses Browserbase or local Playwright under the hood
- Requires an LLM API key — will use Lovable AI gateway

**3. Define the AI task prompts per platform**
- YouTube: "You are on YouTube Studio. Upload a video with title X, description Y. Navigate the upload wizard, set visibility to Public, and get the final video URL."
- TikTok: "You are on TikTok Creator Center. Upload a video, fill the caption, and click Post."
- Instagram: "You are on Instagram. Create a new Reel, upload video, add caption, and Share."
- Each prompt includes credentials context and verification handling instructions

**4. Update Browser Sessions page**
- Show AI decision log (what the AI "saw" and "decided") alongside the live browser view
- Display step-by-step reasoning: "Detected login page → Entering email → Clicking Next → Waiting for password field..."

### Technical Details

**Cloud agentic loop (edge function):**
```text
function agenticUpload(sendCmd, wait, params):
  screenshot = captureScreenshot()
  while not done:
    action = askAI(screenshot, taskDescription, history)
    if action.type == "click": click(action.x, action.y)
    if action.type == "type": typeText(action.selector, action.text)  
    if action.type == "navigate": navigateTo(action.url)
    if action.type == "wait": wait(action.ms)
    if action.type == "done": return action.result
    if action.type == "need_verification": triggerTelegramApproval()
    screenshot = captureScreenshot()
    history.push(action)
```

**AI response schema (structured output via tool calling):**
- action: click | type | navigate | wait | scroll | done | need_verification
- selector: CSS selector or description
- coordinates: {x, y} for click
- text: text to type
- reasoning: why this action was chosen

### Files to create/modify
- **Modify**: `supabase/functions/cloud-browser-upload/index.ts` — replace hardcoded flows with agentic AI loop
- **Modify**: `server/uploaders/youtube.js` — replace with Stagehand
- **Modify**: `server/uploaders/tiktok.js` — replace with Stagehand
- **Modify**: `server/uploaders/instagram.js` — replace with Stagehand
- **Modify**: `server/package.json` — add Stagehand dependency
- **Modify**: `src/pages/BrowserSessions.tsx` — show AI decision log

### What This Gives You
- No more broken automation when platforms change their UI
- AI adapts to any page layout, popup, or unexpected dialog
- Same natural language approach works for any new platform you add later
- Live visibility into what the AI is "thinking" on the Browser Sessions page

