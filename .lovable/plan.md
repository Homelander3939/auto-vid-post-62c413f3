

## Fix Instagram Aspect Ratio — Reliable 9:16 / Original Selection

### Problem
The current code tries to select "Original" or "9:16" on Instagram's crop screen using text matching and positional DOM logic, but it fails silently. Instagram's crop UI uses **icon-only SVG buttons** without readable text labels, so `textContent`-based matching doesn't work. The video ends up cropped to square or 4:5, showing black bars instead of the full vertical frame (as seen on TikTok).

### Root Cause (in `instagram.js` lines 920–1047)
1. **Crop icon detection** relies on aria-labels (`crop`, `aspect`, `resize`) that Instagram doesn't consistently use — their buttons often have no aria-label at all.
2. **Ratio selection** looks for elements with text "original" or "9:16", but Instagram renders these as unlabeled SVG icons (rectangles of different proportions), not text buttons.
3. When both DOM attempts fail, the AI agent fallback is unreliable because its instructions reference UI labels that don't exist.

### Solution
Replace the entire aspect-ratio selection block (Phase 3.5, lines 920–1048) with a more robust strategy:

**Strategy 1 — Direct SVG icon geometry detection:**
- After the video file is set and the crop dialog appears, find ALL small icon-style buttons in the bottom-left area of the dialog.
- Click the first icon button in that area (the crop/expand toggle) to reveal the aspect ratio panel.
- In the revealed panel, identify aspect ratio option buttons by their **SVG `viewBox` dimensions or path bounding boxes** — the tallest/narrowest rectangle icon represents 9:16/portrait. Click it.
- Alternatively, look for the **leftmost** ratio option button (Instagram typically puts "Original" first).

**Strategy 2 — Keyboard shortcut / direct attribute approach:**
- After file upload, check if Instagram shows a crop toolbar. Use `page.evaluate` to enumerate ALL interactive elements in the dialog's bottom toolbar area, log their attributes and dimensions for debugging.
- Click elements by **relative position within the crop toolbar** — first button = aspect toggle, then in the expanded panel, select by icon height-to-width ratio.

**Strategy 3 — AI Agent with screenshot-based vision (existing fallback, improved instructions):**
- Update the agent prompt to describe the **visual appearance** ("small icon in bottom-left showing two corner brackets", "click the tallest/narrowest rectangle icon in the popup") rather than text labels.

### Changes

**File: `server/uploaders/instagram.js`** (Phase 3.5, lines ~920–1048)

Replace the aspect ratio selection with:

1. **Enumerate bottom toolbar buttons** — find all buttons/divs within the bottom 80px of the dialog that contain SVGs. Click the one that appears to be the crop toggle (leftmost small icon button).

2. **Wait 800ms**, then scan for the newly appeared ratio options panel. Identify buttons by:
   - Counting SVG rect/path elements and their aspect ratios
   - The **"Original"** option typically has a landscape-oriented rectangle or just the word hidden in an aria attribute
   - The **portrait/9:16** option has a tall narrow rectangle SVG
   - Select whichever is found first: "Original" (preserves source), then "9:16" portrait

3. **Verification step** — after clicking, check if the preview area's aspect ratio visually changed (the preview container's height should be greater than its width for portrait content). Log the result.

4. **Add console logging** at each micro-step so failures are diagnosable from server logs.

### Technical Detail

The key insight is that Instagram's crop toolbar icons have no text or aria-labels. We must identify them by:
- **Position within dialog** (bottom 60-80px strip)
- **SVG child element geometry** (viewBox ratios, path bounding boxes)  
- **Icon count pattern** — the crop toggle is usually alone or first; ratio options appear as a row of 3-4 icons after clicking it

This approach avoids text matching entirely and works regardless of Instagram's UI language.

