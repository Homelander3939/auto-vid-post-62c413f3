

## Fix Instagram Aspect Ratio + Missing Captions

### Problem 1: Video still uploads at 4:3 on Instagram
The current approach tries to click Instagram's crop/resize UI icons using DOM geometry detection, but Instagram uses unlabeled SVG icon buttons that change between versions. This approach has repeatedly failed.

**Solution: Pre-process the video with ffmpeg before uploading.**
Instead of fighting Instagram's crop UI, convert the video to 9:16 (1080x1920) with black padding BEFORE the upload even starts. Instagram will then receive a properly formatted vertical video and won't crop it.

- In `server/uploaders/instagram.js`, before the file upload step, run `ffmpeg` to:
  - Detect the source video dimensions
  - Scale it to fit within 1080x1920 while preserving aspect ratio
  - Add black padding to fill the remaining space
  - Save to a temp file, use that for upload
- Remove the entire Phase 3.5 (aspect ratio selection) since it's no longer needed — the video is already correctly formatted
- Clean up the temp file after upload completes

### Problem 2: Description/hashtags not appearing on uploaded videos
The caption-filling code exists but the selectors may be failing silently on Instagram's current UI. The screenshots show posts with no description at all.

**Solution: Improve caption filling reliability:**
- Add a `page.waitForSelector` step before attempting caption fill to ensure the caption field is actually rendered
- Scope caption selectors to within the dialog (`[role="dialog"]`) to avoid matching wrong elements
- Add verification logging: after filling, log whether text was actually written
- If all DOM strategies fail, use the AI agent with a clearer prompt that includes the actual caption text

### Files to Change

1. **`server/uploaders/instagram.js`**
   - Add ffmpeg pre-processing function at the top
   - Call it before Phase 3 (file upload) to create a 9:16 padded video
   - Remove Phase 3.5 entirely (crop/resize icon detection)
   - Improve Phase 5 caption filling: scope selectors to dialog, add wait step, better verification
   - Add temp file cleanup in a finally block

### Technical Detail

ffmpeg command for black-padded 9:16 conversion:
```
ffmpeg -i input.mp4 -vf "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black" -c:a copy output.mp4
```

This scales the video to fit within 1080x1920 while keeping its original aspect ratio, then pads with black bars to fill the full 9:16 frame. The user confirmed they want black padding.

