// Shared helper to dismiss tip / announcement / promo overlays that block
// upload automation on Instagram, YouTube, and TikTok.
//
// Strategy (in order):
//  1) Click obvious confirm buttons inside any visible dialog: "OK", "Got it",
//     "Dismiss", "Not now", "Skip", "Continue", "Close", "I understand".
//  2) Press the Escape key (closes most non-modal toasts/popovers).
//  3) Click on a neutral background area away from interactive elements
//     (top-left of viewport) to dismiss lightweight tooltips/coachmarks that
//     close on outside-click.
//
// All actions are best-effort — failures are swallowed so this can be safely
// called from any "stuck" recovery path.

const DISMISS_LABELS = [
  'OK', 'Ok', 'Got it', 'Got It', 'Dismiss', 'Not now', 'Not Now',
  'Skip', 'Skip for now', 'Continue', 'Close', 'I understand',
  'No thanks', 'Maybe later', 'Done', 'Allow', 'Confirm',
];

async function dismissOverlayBlockingFlow(page, opts = {}) {
  const { logPrefix = '[OverlayDismiss]', clickBackground = true } = opts;
  let dismissed = false;

  // 1) Click any dismiss button inside a visible dialog/role=alertdialog.
  try {
    const clicked = await page.evaluate((labels) => {
      const lower = labels.map((l) => l.toLowerCase());
      const dialogs = Array.from(document.querySelectorAll(
        '[role="dialog"], [role="alertdialog"], [aria-modal="true"]'
      ));
      for (const dlg of dialogs) {
        const rect = dlg.getBoundingClientRect();
        if (rect.width < 50 || rect.height < 50) continue;
        const buttons = Array.from(dlg.querySelectorAll(
          'button, [role="button"], div[tabindex], a[role="button"]'
        ));
        for (const btn of buttons) {
          const text = (btn.innerText || btn.textContent || '').trim().toLowerCase();
          if (!text || text.length > 30) continue;
          if (lower.some((l) => text === l || text.startsWith(l + ' ') || text === l + '!')) {
            const r = btn.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) {
              btn.click();
              return text;
            }
          }
        }
      }
      return null;
    }, DISMISS_LABELS);
    if (clicked) {
      console.log(`${logPrefix} Clicked dismiss button: "${clicked}"`);
      dismissed = true;
      await page.waitForTimeout(800);
    }
  } catch {}

  // 2) Press Escape — closes most lightweight popovers/tooltips.
  if (!dismissed) {
    try {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(400);
    } catch {}
  }

  // 3) Click a neutral background area (top-left corner of viewport).
  //    This dismisses coachmarks/tooltips that close on outside-click without
  //    triggering navigation or accidental form actions.
  if (clickBackground) {
    try {
      const safe = await page.evaluate(() => {
        // Pick a point in the upper-left viewport that is NOT inside any
        // interactive element — fall back to (10, 10).
        const candidates = [[10, 10], [40, 80], [80, 40]];
        for (const [x, y] of candidates) {
          const el = document.elementFromPoint(x, y);
          if (!el) return { x, y };
          const tag = el.tagName.toLowerCase();
          if (['button', 'a', 'input', 'textarea', 'select'].includes(tag)) continue;
          if (el.closest('[role="button"], [role="link"], [role="dialog"]')) continue;
          return { x, y };
        }
        return { x: 10, y: 10 };
      });
      await page.mouse.click(safe.x, safe.y, { delay: 30 });
      await page.waitForTimeout(400);
      console.log(`${logPrefix} Clicked background at (${safe.x},${safe.y}) to dismiss tip overlay`);
      dismissed = true;
    } catch {}
  }

  return dismissed;
}

module.exports = { dismissOverlayBlockingFlow };
