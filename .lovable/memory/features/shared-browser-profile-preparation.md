---
name: Shared Browser Profile Preparation
description: Non-default platform accounts must be explicitly linked to a reusable local Chrome profile via a Prepare action before uploads reuse saved logins across YouTube, TikTok, and Instagram.
type: feature
---
- In local mode, each platform account can be prepared by opening its linked persistent Chrome profile before first upload.
- Related accounts representing the same brand/person across YouTube, TikTok, and Instagram should reuse one shared browser profile when labels or email prefixes match.
- Job and scheduled upload processing must persist per-platform account selections locally so the worker uses the intended account/profile for each platform instead of falling back to the main default profile.
