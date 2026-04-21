# Goal

Turn the AI Chat (web + Telegram) into a real coding/research **agent** — like Claude Code / Codex — that uses the user's configured **AI model**, **research provider**, and **image model** keys, plus the **local Windows PC** (browser, file system, code preview), to autonomously execute multi-step tasks: deep research, image generation, building small apps, opening browsers, creating/editing files on the local machine, and previewing them.

Today the chat has tool-calling for upload/post automation only. Research/image/browser tools just queue a single command and reply "results in Telegram in 1-3 min". There is no file system, no code workspace, no live agent loop with visible thinking steps, and the user-configured AI/research/image keys are not actually used as the agent backbone.

# What you'll see when this ships

A unified "Agent" experience in **AI Chat** and **Telegram**:

1. You type: *"Research the top 5 AI video tools this month, then build me a comparison landing page and open it in my browser."*
2. The agent immediately shows a live **plan** + **streaming step feed** (like Claude Code):
  ```text
   🧭 Plan
  ```
  1. Research AI video tools (deep web research)
  2. Generate hero image
  3. Scaffold landing page (HTML + Tailwind)
  4. Save to ~/AgentWorkspace/ai-video-tools/
  5. Open in browser preview
    ep 1: Researching… (Perplexity · 12 sources found)
    ep 2: Generating hero image… (Gemini Nano Banana)
    ep 3: Writing index.html (4.2 KB)
    ved to C:\Usersyou>\AgentWorkspace\ai-video-tools  
    ened [http://localhost:3001/agent-preview/ai-video-tools/](http://localhost:3001/agent-preview/ai-video-tools/)
3. Same feed mirrors to Telegram (compact text + thumbnails).
4. Output files live in a real folder on your PC and are previewable through the local server.

# How it will work (technical)

### 1. New "Agent Runner" — replaces single-shot tool calls with a real loop

- New edge function `agent-run` and matching local handler `server/agent-runner.js`.
- Runs an **iterative agent loop** (plan → act → observe → repeat, up to N steps) using the **user's configured AI provider** from `app_settings.ai_provider/ai_api_key/ai_model` (OpenAI, Anthropic, Lovable AI, or LM Studio local). Falls back to Lovable AI if no key.
- Streams each step (`plan`, `tool_call`, `tool_result`, `thought`, `file_write`, `done`) into a new `agent_runs` table with an `events JSONB[]` column — same pattern already used by `generation_jobs`.

### 2. New tools the agent can call

On top of the existing upload/post tools, add:


| Tool                       | Backend                                                                                                                                         | What it does                                                           |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `research_deep`            | uses configured **research_provider** (Perplexity / Firecrawl / Tavily) directly with user's `research_api_key`; falls back to local Playwright | Returns synthesized findings + sources, inline (not async to Telegram) |
| `generate_image`           | uses configured **image_provider** + `image_api_key` (Gemini, OpenAI, Stability) — picks first working key                                      | Returns image URL, embedded in chat                                    |
| `write_file`               | local server writes to `~/AgentWorkspace/<project>/<path>`                                                                                      | Confirms path + size                                                   |
| `read_file` / `list_files` | local server                                                                                                                                    | Returns content/listing                                                |
| `run_shell`                | local server (allowlisted: `npm`, `node`, `python`, `git`) with confirmation toggle                                                             | Streams stdout                                                         |
| `open_in_browser`          | local server opens default browser at given URL or local file                                                                                   | Confirms                                                               |
| `serve_preview`            | local server serves `~/AgentWorkspace/<project>/` at `http://localhost:3001/agent-preview/<project>/`                                           | Returns preview URL                                                    |
| `scaffold_app`             | helper that combines `write_file` for a Vite/HTML/React starter                                                                                 | Returns project path                                                   |


Cloud mode keeps `research_deep`, `generate_image`, and queued `open_browser` (file/shell tools require local server — when local is offline the chat tells the user clearly).

### 3. Live "thinking" UI in AI Chat

Rebuild the message renderer to show, inside the assistant bubble:

- A collapsible **Plan** panel (numbered steps with status dots).
- A **live activity feed** (one line per tool call: emoji + label + spinner → check/cross + duration).
- Inline **rich results**: image thumbnails for `generate_image`, source cards for `research_deep`, a code block + "Open preview" button for `write_file`/`serve_preview`.
- Subscribes to `agent_runs` via Supabase Realtime so steps appear immediately, not after the full reply.

### 4. Telegram parity

The Telegram bot taps the same `agent-run` function. It posts a single status message and **edits it in place** as steps complete (Telegram `editMessageText`), so users see the same live progression in chat. Final artifacts (images, preview URL, file list) are sent as follow-up messages.

### 5. Local "Agent Workspace" on the Windows PC

- New folder `server/data/agent-workspace/` (auto-created), exposed via:
  - `POST /api/agent/file` (read/write/list)
  - `POST /api/agent/shell` (allowlisted commands)
  - `POST /api/agent/open` (opens URL/file in default browser)
  - `GET  /agent-preview/<project>/*` (static file server)
- Each agent run gets its own subfolder (slugified from prompt) so projects don't collide.
- Settings page gets a small "Agent Workspace" section showing the path, a "Open folder" button, and a master toggle for `run_shell`.

### 6. Database

One new migration:

- `agent_runs` — `id`, `prompt`, `status`, `events JSONB[]`, `model`, `workspace_path`, `created_at`, `completed_at`.
- Add `agent_shell_enabled BOOLEAN DEFAULT false` to `app_settings`.
- RLS: same pattern as `generation_jobs` (open to authenticated, service-role writes).

### 7. Wiring the user's keys

- The agent loop reads `app_settings` once per run and builds a **provider map**: `chat → ai_provider/key/model`, `research → research_provider/key`, `image → first working image_keys entry`.
- Each tool dispatches through that map so the user's keys are genuinely used; no silent fallback to Lovable AI unless a key is missing or returns 401/402 (and then the chat says so explicitly).

### 8. Files touched

- **New**: `supabase/functions/agent-run/index.ts`, `server/agent-runner.js`, `server/agentWorkspace.js`, `src/components/AgentRunPanel.tsx`, migration file.
- **Edited**: `supabase/functions/ai-chat/index.ts` (delegates complex/multi-step prompts to `agent-run` instead of single tool calls), `src/pages/AIChat.tsx` (renders `AgentRunPanel` inline), `server/index.js` (mounts new endpoints + polls `agent_runs` for local-side tools), `src/pages/SettingsPage.tsx` (workspace section + shell toggle), `src/lib/socialPosts.ts` (helper to read provider map).
- **Untouched**: existing video upload, scheduling, campaigns, social-post generation flows — all keep working exactly as today.

# Out of scope (to keep this focused)

- No multi-user agent isolation (single-user app).
- No long-running daemons spawned by the agent — `run_shell` is one-shot with a timeout.
- No code editing of the project's own source — the workspace is a separate folder.

# Open questions before I build

None blocking — defaults: workspace at `server/data/agent-workspace/`, `run_shell` **off** by default (toggle in Settings), max 12 agent steps per run. I'll proceed with these unless you say otherwise.

It should be better agent for winodws as open claw is for ios and hermes is for linux.