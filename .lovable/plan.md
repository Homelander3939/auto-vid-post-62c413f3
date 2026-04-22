<final-text>
Goal: restore a single, reliable AI stack so chat, skills, memory, search, image generation, and agentic flows work together with your configured API keys, without changing video upload or social posting behavior.

1. Lock scope and preserve working subsystems
- Do not change video upload execution, scheduled uploads, local uploaders, or social post publishing behavior.
- Treat the current post-generation flow as the known-good reference for provider handling and fallback behavior.
- Only touch the AI chat, autonomous agent, skills/memory, settings, and the local agent bridge.

2. Fix the core architecture split that GitHub Copilot introduced
- The project currently has two competing AI architectures:
  - the original local-worker/LM Studio design described in project memory and `server/ai-handler.js`
  - the newer cloud chat + cloud agent path in `src/pages/AIChat.tsx`, `supabase/functions/ai-chat`, and `supabase/functions/agent-run`
- Unify them under one rule:
  - normal chat stays lightweight
  - anything needing tools, memory, search, image generation, file work, shell, browser, or multi-step reasoning must route into the autonomous agent path
- Replace the brittle frontend-only heuristic (`shouldLaunchAgentRun`) with a backend intent router plus an explicit “Always use agent” toggle in chat.

3. Make model/provider handling consistent everywhere
- Use one shared provider-resolution layer for:
  - AI chat
  - autonomous agent planner/reviewer
  - connection tests
  - model listing
- Enforce save-time validation in Settings so unsupported models like `qwen/qwen3.5-397b-a17b` cannot remain stored for agentic flows.
- Add a backend migration/self-heal step to normalize existing bad saved model values.
- Surface fallback reasons in the UI so the user can see when the system is using:
  - their API key/model
  - a compatible fallback model
  - built-in Lovable AI as emergency fallback
- This directly addresses the logged crash where the autonomous agent tried an unsupported model.

4. Fix why chat does not behave like the working post-generation AI
- The post generator already has stronger provider fallback and image-chain handling than chat.
- The chat function currently has separate logic and also forces built-in models in key places:
  - image attachments force a built-in vision model
  - after tool calls, the second-pass reply always switches to the built-in default model
- Refactor chat so it follows the same provider policy as the working post-generation flow:
  - use the configured compatible provider/model for the initial reasoning pass
  - use an explicit capability matrix for tool-calling compatibility
  - only fallback when required, and record that fallback visibly
- Keep the post-generation flow behavior unchanged; only reuse its reliable provider patterns.

5. Fix search API and image generation API integration end-to-end
- Research/search problems today:
  - “auto” testing assumes Brave when any key is present, which mis-tests Tavily/Serper/Firecrawl keys
  - local-browser fallback depends on the local worker but chat does not preflight that dependency clearly
- Image problems today:
  - “auto” testing assumes Unsplash when any image key is present, which mis-tests Google/OpenAI/NVIDIA/xAI keys
  - model loading in auto mode defaults to built-in instead of the user’s actual provider
- Implement:
  - correct provider auto-detection everywhere
  - proper provider-specific test flow
  - unified image fallback chain in agent-run using the same pattern already proven in post generation
  - clear local-worker health checks before using local search/browser tools
- Result: your own keys become the primary path, with deterministic fallback only when necessary.

6. Make skills and memory actually participate in chat
- Right now skills/memory work only inside the autonomous agent run, not in standard chat.
- Normal chat also only sends browser-local app messages, while Telegram-visible history is mostly visual and not part of the true model context.
- Fix by:
  - moving reusable memory/skill retrieval to the backend request router
  - loading relevant memories and matched skills for every agentic request
  - allowing chat to promote itself into an agent run whenever memory/skills/tools are needed
  - storing durable conversation context server-side instead of only localStorage
  - ensuring cross-channel history is real context, not just merged UI display
- Keep durable memory strict: only save reusable facts/workflows/preferences, not every reply.

7. Strengthen the local agent bridge so agentic flows stop silently degrading
- The autonomous agent depends on the local worker for:
  - file reads/writes
  - shell commands
  - browser tasks
  - local search fallback
  - previews
- Add explicit backend preflight checks and agent event reporting for:
  - local worker reachable/unreachable
  - shell enabled/disabled
  - workspace path valid/invalid
  - browser task blocked by safe mode
- If a local dependency is unavailable, the run should fail with an exact reason in chat and in the activity panel instead of feeling “broken”.

8. Secure API key handling before relying on your own keys
- Right now AI/search/image keys are stored in a broadly readable settings table, which is not safe for real API keys.
- Move sensitive AI/search/image credentials out of public app settings into secure backend-only storage.
- Keep only non-sensitive selections in settings visible to the app:
  - provider
  - model
  - mode toggles
  - labels for fallback keys
- Update chat, agent-run, tests, and the local worker bridge to read real secrets from the secure backend path.
- This is necessary if you want dependable use of your own keys without exposing them.

9. Improve visibility so you can see what path the AI is using
- Add lightweight diagnostics to chat and settings:
  - current active provider/model
  - whether fallback occurred
  - search provider status
  - image provider status
  - local worker status
  - memory enabled / skills matched
- This turns “it doesn’t work” into a debuggable visible state.

10. Regression coverage and validation
- Add tests for:
  - model normalization and fallback
  - provider auto-detection
  - agent-run planner/reviewer using configured keys
  - research/image tool execution
  - skill import, recall, save, improve
  - memory recall and memory-off behavior
  - chat-to-agent routing
- Validate that unchanged areas still behave the same:
  - video upload queue
  - scheduled uploads
  - local platform uploaders
  - social post generation/publishing flow

Root causes confirmed from the codebase
- Chat and post generation use different AI pipelines; post generation is more robust.
- Standard chat does not truly use the skills/memory system; only autonomous agent runs do.
- Chat routing into the autonomous agent is heuristic and easy to miss.
- Search/image “auto” test logic is wrong for many key types.
- The autonomous agent crashed on an unsupported saved model.
- Tool-driven chat often falls back to built-in AI even when a custom provider is configured.
- Local-agent capabilities depend on the local worker, but failure states are not surfaced clearly.
- Sensitive API keys are currently stored in an unsafe place for real production use.

Files likely involved
- Frontend:
  - `src/pages/AIChat.tsx`
  - `src/pages/SettingsPage.tsx`
  - `src/pages/AgentSkills.tsx`
  - `src/components/AgentRunPanel.tsx`
  - `src/lib/socialPosts.ts`
  - `src/lib/agentChat.ts`
- Backend functions:
  - `supabase/functions/_shared/ai-provider.ts`
  - `supabase/functions/ai-chat/index.ts`
  - `supabase/functions/agent-run/index.ts`
  - `supabase/functions/test-ai-connection/index.ts`
  - `supabase/functions/test-agent-connection/index.ts`
  - `supabase/functions/list-ai-models/index.ts`
  - `supabase/functions/list-image-models/index.ts`
- Local worker:
  - `server/index.js`
  - `server/agentWorkspace.js`
- Database/backend config:
  - settings + agent memory/skills/agent run storage
  - a new secure credential storage layer
  - one migration to sanitize invalid saved model values

Explicit no-touch areas
- `server/uploaders/*`
- video upload processing flow
- scheduled upload execution
- social post publishing behavior
- the working social post generation output logic, except reusing its provider/fallback patterns where safe and behavior-neutral

Definition of done
- Chat can use your configured model/provider predictably.
- Search works with your configured research key or clearly falls back locally.
- Image generation works with your configured image provider/model chain.
- Agentic flows reliably enter the autonomous agent path when they should.
- Skills and memory influence real runs, not just the UI.
- Fallbacks are visible, not silent.
- Your API keys are no longer exposed through public settings.
- Video upload and social posting continue to behave exactly as before.
</final-text>