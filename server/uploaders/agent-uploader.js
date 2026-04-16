/**
 * agent-uploader.js
 *
 * AI-driven upload helper using the runAgentTask agentic loop from smart-agent.js.
 *
 * Background / Why not page-agent?
 * ─────────────────────────────────
 * The Alibaba page-agent library (https://github.com/alibaba/page-agent) is a
 * *client-side* JavaScript library: it injects itself into a running web page
 * and controls the DOM from within the browser's JavaScript context.  That
 * design is ideal for embedding an AI copilot inside a React/Vue app, but it
 * cannot be used here because our automation runs from a Node.js server that
 * controls Chromium through Playwright's external DevTools Protocol.
 *
 * Instead we implement the same core ideas natively:
 *   • Natural-language task goals (like page-agent's agent.execute())
 *   • Text-based DOM extraction so no multi-modal model is needed
 *   • Iterative plan → execute loop (the "agentic" part)
 *
 * Usage (called by youtube.js / tiktok.js / instagram.js or directly):
 *
 *   const { agentUpload } = require('./agent-uploader');
 *   const result = await agentUpload(page, {
 *     platform: 'youtube',
 *     videoPath: '/tmp/video.mp4',
 *     title: 'My Short',
 *     description: 'Auto-posted via AI',
 *     tags: ['shorts', 'ai'],
 *   });
 *   // result: { success, url, steps, error }
 */

'use strict';

const { runAgentTask, isVisionEnabled } = require('./smart-agent');

/**
 * Map a platform + video metadata to a natural-language upload goal string.
 *
 * @param {'youtube'|'tiktok'|'instagram'} platform
 * @param {object} meta
 * @returns {string}
 */
function buildGoal(platform, meta) {
  const { title, description, tags = [] } = meta;
  const tagList = tags.slice(0, 5).join(', ');

  switch (platform) {
    case 'youtube':
      return (
        `On YouTube Studio (studio.youtube.com), upload the video file that has ` +
        `already been set on the file input. ` +
        `Set the title to "${title}". ` +
        (description ? `Set the description to: ${description.substring(0, 200)}. ` : '') +
        (tagList ? `Add tags: ${tagList}. ` : '') +
        `Select "No, it's not made for kids". ` +
        `Click the Publish / Save button. ` +
        `Wait until the video URL is visible in the confirmation dialog.`
      );

    case 'tiktok':
      return (
        `On the TikTok Creator Center (tiktok.com/creator-center), ` +
        `fill in the caption / description field with: "` +
        (description ? `${description.substring(0, 150)}` : title) +
        `". ` +
        `Then click the Post button and wait until the success confirmation appears.`
      );

    case 'instagram':
      return (
        `On Instagram (instagram.com), complete the new-post flow: ` +
        `click through the crop / trim screens by clicking Next, ` +
        `then fill in the caption with: "${title}` +
        (description ? ` ${description.substring(0, 150)}` : '') +
        `". ` +
        `Finally click Share and wait until the success message appears.`
      );

    default:
      return `Complete the video upload on ${platform} with title "${title}".`;
  }
}

/**
 * Use the agentic loop to drive a video upload on the given platform page.
 *
 * The caller is responsible for:
 *  1. Launching the Playwright page (persistent context with login cookies)
 *  2. Navigating to the upload entry-point and setting the file input (for
 *     platforms that require a file input, e.g. YouTube Studio).
 *  3. Passing the already-open `page` to this function.
 *
 * The agent takes it from there, handling the details form, publish button,
 * and confirmation using natural language reasoning.
 *
 * @param {import('playwright').Page} page        Playwright page (already on upload screen)
 * @param {object} opts
 * @param {'youtube'|'tiktok'|'instagram'} opts.platform
 * @param {string}   opts.title
 * @param {string}   [opts.description]
 * @param {string[]} [opts.tags]
 * @param {number}   [opts.maxSteps=20]       Override the step budget
 * @param {boolean}  [opts.useVision=false]   Attach screenshot to each LLM call
 * @param {boolean}  [opts.verbose=true]
 * @returns {Promise<{success:boolean, url:string|null, steps:object[], error:string|null}>}
 */
async function agentUpload(page, opts = {}) {
  const {
    platform,
    title,
    description = '',
    tags = [],
    maxSteps = 20,
    useVision = isVisionEnabled(),
    verbose = true,
  } = opts;

  if (!platform) throw new Error('agentUpload: opts.platform is required');
  if (!title) throw new Error('agentUpload: opts.title is required');

  const goal = buildGoal(platform, { title, description, tags });

  if (verbose) {
    console.log(`[AgentUploader] Starting agentic upload on ${platform}`);
    console.log(`[AgentUploader] Goal: ${goal.substring(0, 120)}…`);
  }

  let result;
  try {
    result = await runAgentTask(page, goal, { maxSteps, useVision, verbose });
  } catch (err) {
    return { success: false, url: null, steps: [], error: err.message };
  }

  // Try to extract the published URL from the page after a successful run
  let url = null;
  if (result.success) {
    url = await extractPublishedUrl(page, platform);
  }

  return {
    success: result.success,
    url,
    steps: result.steps,
    error: result.success ? null : `Agent ended with state: ${result.finalState}`,
  };
}

/**
 * Best-effort extraction of the published video URL after a successful upload.
 *
 * @param {import('playwright').Page} page
 * @param {string} platform
 * @returns {Promise<string|null>}
 */
async function extractPublishedUrl(page, platform) {
  try {
    if (platform === 'youtube') {
      // YouTube Studio confirmation dialog shows a "watch" link
      const link = await page.$('a[href*="youtu.be"], a[href*="youtube.com/shorts"], a[href*="youtube.com/watch"]');
      if (link) return await link.getAttribute('href');
    }
    if (platform === 'tiktok') {
      const link = await page.$('a[href*="tiktok.com/@"]');
      if (link) return await link.getAttribute('href');
    }
    if (platform === 'instagram') {
      const link = await page.$('a[href*="instagram.com/reel"], a[href*="instagram.com/p/"]');
      if (link) return await link.getAttribute('href');
    }
  } catch {
    // Non-fatal
  }
  return null;
}

module.exports = { agentUpload, buildGoal };
