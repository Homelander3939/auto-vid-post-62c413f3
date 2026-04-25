Goal: make every non-video AI action produce a real visible result across Job Queue, Telegram, and AI Chat; make local browser research actually navigate/read/capture pages using LM Studio vision; and synchronize Instagram/social post outcomes back into AI Chat. Do not change video upload execution/uploaders.

Findings from the screenshots and code
- Telegram still receives raw local-model reasoning in some paths, especially the local worker `ai_response` path and generic browser task path.
- Local browser tasks are too generic: `runBrowserTask()` opens a page, asks the small local model for one Playwright action at a time, then returns only `finalUrl/finalTitle`. It does not reliably extract the requested result, does not save screenshots, and does not send screenshots/artifacts back.
- AI Chat is not truly synchronized with Telegram because many Telegram messages sent by the local worker and generation functions are not inserted into `telegram_messages`; Telegram getUpdates will not return the bot’s own sent messages.
- Job Queue already shows `agent_runs`, `generation_jobs`, `social_posts`, and some `pending_commands`, but result links are incomplete. Browser task rows do not expose screenshots/result pages, and agent rows do not show artifact links clearly.
- Scheduled post generation runs through `run-due-generations`, but it does not always create an immediate visible queue row and final result link in the same way as manual generation.

Implementation plan

1. Add a unified result/report layer for all AI tasks
- Use existing tables where possible: `agent_runs.events/result`, `generation_jobs.events/result/saved_post_id`, `social_posts.platform_results`, and `pending_commands.result`.
- Standardize result JSON for local commands:
  - `summary`
  - `status`
  - `links[]` with `{ label, url, kind }`
  - `screenshots[]` with `{ label, url, path }`
  - `sources[]`
  - `artifacts[]`
- Update Job Queue (`AITasksPanel`) to render openable result links for:
  - generated social drafts (`/social` plus post id when available)
  - browser final URL
  - local screenshot URLs
  - research source URLs
  - generated image/social image URLs
  - agent-run artifacts from `finish.artifacts` and `result.artifacts`

2. Mirror every outgoing Telegram bot message into AI Chat history
- Wrap all Telegram sending code paths with a shared “send and mirror” behavior.
- For local worker notifications (`notifyTelegram` in `server/index.js`), after sending Telegram, insert a bot row into `telegram_messages` with `is_bot=true` and `raw_update.source='local-worker'`.
- For social post publishing results (`server/socialPostProcessor.js`), ensure final success/failure messages are mirrored.
- For browser tasks and stats checks, mirror summaries and artifact links.
- For edge functions that send Telegram previews/results (`ai-chat`, `generate-social-post`, `agent-run`), insert matching bot rows where they do not already.
- Result: AI Chat’s Telegram synced feed will show Instagram/social results, generation previews, browser results, and final agent summaries.

3. Replace generic local browser task behavior with deterministic browser research/report mode
- Add a dedicated local command for browser research, e.g. `browser_research_report`, instead of relying only on `open_browser`.
- The command will:
  - open a persistent local Chromium profile
  - search the web for the requested query
  - click/open the top sources one by one
  - extract page title, URL, visible text, and key snippets
  - capture screenshots of source pages
  - optionally use LM Studio vision to summarize what is visible on the screenshots
  - synthesize the final answer/post drafts locally
  - save screenshots to a user-visible local/static endpoint or upload them to existing public storage when running through the cloud bridge
  - return structured result JSON to `pending_commands.result`
  - send a final Telegram message with sources, open links, and screenshots when requested
- Keep existing video upload browser sessions untouched.

4. Give local vision models a real screenshot analysis tool
- Extend `smart-agent.js`/local browser tooling with explicit tools:
  - `capture_screenshot`
  - `analyze_screenshot_with_lmstudio`
  - `extract_page_text`
  - `open_source_url`
  - `finish_with_report`
- Update local prompts for Qwen/Gemma/GLM-style models:
  - no hidden thinking in final output
  - always return strict JSON for action decisions
  - prefer deterministic DOM/search extraction first
  - use screenshot vision when page text is insufficient or visual content matters
  - never claim completion until a report/result artifact is produced
- Add sanitization at the final Telegram/local worker boundary so even if a model leaks “thinking process”, Telegram receives only the useful result.

5. Improve cloud agent routing for local-use requests
- In `ai-chat` and `agent-run`, route requests like:
  - “open browser and research…”
  - “find latest news and send top 3 posts…”
  - “take screenshot and send me…”
  - “browse site and report…”
  to the new `browser_research_report` command or to `agent-run` with browser-report instructions, not to generic `open_browser`.
- Update `agent-run`’s `browser_task` tool result handling so it returns the report JSON to the planner and saves screenshot/source artifacts in `agent_runs.events`.
- Increase reliability for local/smaller models by using deterministic pre/post processing around the LLM instead of asking the model to do the whole browser workflow alone.

6. Fix post generation/scheduled generation visibility and final links
- Ensure every manual and scheduled generation creates/updates a `generation_jobs` row immediately.
- On completion, store `saved_post_id` and `result` consistently.
- Send a final message to Telegram and AI Chat with:
  - “Draft ready” / “Posted” status
  - post id
  - open link to Social Posts / draft
  - image link if generated
  - source links
- For scheduled generation, include schedule name/run number in events so Job Queue clearly shows what triggered it.

7. Fix Instagram/social publishing synchronization
- Keep Instagram uploader behavior unchanged.
- Update the social post processor around it to:
  - mirror processing start/final result to AI Chat via `telegram_messages`
  - include actual platform result URLs when available
  - include a Job Queue open link to the `social_posts` row/result
  - mark partial/failure details clearly per platform
- This addresses “Instagram and AI chat are not synchronized” without touching video upload or Instagram video uploader logic.

8. Harden final responses and remove internal prompt leakage everywhere
- Apply sanitizer consistently in:
  - `server/ai-handler.js`
  - `server/index.js` Telegram notifications for AI/browser tasks
  - `supabase/functions/ai-chat/index.ts`
  - `supabase/functions/agent-run/index.ts` Telegram status/final rendering
- Strip or replace sections like:
  - “thinking process”
  - “analyze user input”
  - “check context/constraints”
  - “self-correction/verification”
  - raw system prompt text
- For identity/basic questions, return a short direct answer instead of starting agentic task flow.

9. Validate only non-video paths
- Run TypeScript/build checks and focused tests if available.
- Inspect edge-function code for CORS and response handling.
- Do not modify video upload uploaders or scheduled video upload logic.
- After implementation, the expected behavior is:
  - Ask from Telegram: “open browser, find latest Georgia news, send top 3 social posts”
  - Job Queue shows an autonomous/browser research row live.
  - Local browser opens sources, captures screenshots, extracts content, and returns top 3 posts with source links.
  - Telegram receives final result, links, and screenshots.
  - AI Chat shows the same bot result because outgoing Telegram messages are mirrored.
  - Manual and scheduled post generations show final draft links and are mirrored to Telegram/AI Chat.

Technical files likely to change
- `server/index.js`
- `server/uploaders/stats-scraper.js`
- `server/uploaders/smart-agent.js`
- `server/socialPostProcessor.js`
- `server/ai-handler.js`
- `supabase/functions/ai-chat/index.ts`
- `supabase/functions/agent-run/index.ts`
- `supabase/functions/generate-social-post/index.ts`
- `supabase/functions/run-due-generations/index.ts`
- `src/components/AITasksPanel.tsx`
- possibly `src/lib/socialPosts.ts` for typing/result parsing

Scope guard
- No changes to video upload execution logic.
- No changes to YouTube/TikTok/Instagram video uploader flows except using existing exported helpers if already present.
- Focus is AI chat, Telegram sync, social post generation/publishing notifications, local browser research, screenshots, and Job Queue result links.