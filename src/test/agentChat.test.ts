import { describe, expect, it } from 'vitest';
import { buildAgentRunPrompt, shouldLaunchAgentRun } from '@/lib/agentChat';

describe('agentChat helpers', () => {
  it('detects complex agentic prompts', () => {
    expect(shouldLaunchAgentRun('Do agentic research, generate a portfolio website, and build the code step by step.')).toBe(true);
  });

  it('keeps simple chat prompts in normal mode', () => {
    expect(shouldLaunchAgentRun('Suggest three hashtags for my next TikTok post.')).toBe(false);
  });

  it('does not force agent mode for unrelated short research phrasing', () => {
    expect(shouldLaunchAgentRun('Can you research three hashtags for this post?')).toBe(false);
  });

  it('upgrades text-file workflows into agent runs', () => {
    expect(shouldLaunchAgentRun('Please use the attached brief.', [{
      name: 'brief.md',
      textContent: '# Goals',
      isImage: false,
    }])).toBe(true);
  });

  it('builds an agent prompt with file context', () => {
    const prompt = buildAgentRunPrompt('Create the app', [{
      name: 'brief.md',
      type: 'text/markdown',
      size: '2 KB',
      url: 'https://example.com/brief.md',
      textContent: 'Use a clean bento grid layout.',
      isImage: false,
    }]);

    expect(prompt).toContain('Create the app');
    expect(prompt).toContain('brief.md');
    expect(prompt).toContain('Show live progress in the app.');
  });
});
