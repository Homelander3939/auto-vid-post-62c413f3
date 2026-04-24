// Shared agent intent router — used by both ai-chat (server-side authoritative)
// and the frontend (for fast UI hints). Keep behavior in one place.

export interface AgentIntentAttachment {
  name?: string;
  type?: string;
  isImage?: boolean;
  textContent?: string | null;
}

const AGENTIC_PATTERNS = [
  /\bagentic\b/i,
  /\bautonomous\b/i,
  /\bstep[\s-]*by[\s-]*step\b/i,
  /\bresearch\b[\s\S]{0,80}\b(build|create|generate|write|design|code)\b/i,
  /\b(build|create|generate|design|code|prototype|develop)\b[\s\S]{0,80}\b(app|website|landing page|portfolio|workflow|automation|agent|flow)\b/i,
  /\b(open|use|run)\b[\s\S]{0,40}\bbrowser\b/i,
  /\bclaude code\b|\bcodex\b|\bopenclaw\b/i,
];
const MIN_AGENTIC_PROMPT_LENGTH = 220;

export function shouldLaunchAgentRun(
  text: string,
  files: AgentIntentAttachment[] = [],
): boolean {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (!normalized && files.length === 0) return false;
  if (files.some((file) => !file.isImage && !!file.textContent)) return true;
  if (normalized.length >= MIN_AGENTIC_PROMPT_LENGTH) return true;
  return AGENTIC_PATTERNS.some((p) => p.test(normalized));
}
