import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const TELEGRAM_GATEWAY = 'https://connector-gateway.lovable.dev/telegram';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, supabaseKey);

  const LOVABLE_API_KEY = Deno.env.get('LOVABLE_API_KEY');
  const TELEGRAM_API_KEY = Deno.env.get('TELEGRAM_API_KEY');

  // Get settings (includes platform credentials and Telegram config)
  const { data: settings } = await supabase
    .from('app_settings')
    .select('*')
    .eq('id', 1)
    .single();

  if (!settings) {
    return new Response(JSON.stringify({ ok: false, error: 'No settings found' }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const uploadMode = (settings as any).upload_mode || 'local';

  // In cloud mode, platform credentials are stored in app_settings:
  // YouTube: email = client_id, password = client_secret
  // TikTok: email = access_token
  // Instagram: email = access_token, password = business_account_id
  // The refresh token for YouTube is stored via secrets
  const YOUTUBE_REFRESH_TOKEN = Deno.env.get('YOUTUBE_REFRESH_TOKEN');

  const telegramChatId = settings?.telegram_chat_id;
  const telegramEnabled = settings?.telegram_enabled && TELEGRAM_API_KEY && LOVABLE_API_KEY;

  // Send Telegram notification helper
  async function notifyTelegram(text: string) {
    if (!telegramEnabled || !telegramChatId) return;
    try {
      await fetch(`${TELEGRAM_GATEWAY}/sendMessage`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${LOVABLE_API_KEY}`,
          'X-Connection-Api-Key': TELEGRAM_API_KEY!,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ chat_id: telegramChatId, text, parse_mode: 'HTML' }),
      });
    } catch (e) {
      console.error('Telegram notification failed:', e);
    }
  }

  // Fix stale "uploading" jobs (stuck for >10 minutes = likely crashed session)
  const staleThreshold = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const { data: staleJobs } = await supabase
    .from('upload_jobs')
    .select('*')
    .eq('status', 'uploading')
    .lt('created_at', staleThreshold);

  if (staleJobs && staleJobs.length > 0) {
    for (const stale of staleJobs) {
      const pr = (stale.platform_results as any[]) || [];
      let changed = false;
      for (const p of pr) {
        if (p.status === 'uploading') {
          p.status = 'error';
          p.error = 'Upload timed out or session crashed.';
          changed = true;
        }
      }
      if (changed) {
        const allDone = pr.every((p: any) => p.status === 'success' || p.status === 'error');
        const finalStatus = allDone
          ? (pr.every((p: any) => p.status === 'success') ? 'completed' : (pr.some((p: any) => p.status === 'success') ? 'partial' : 'failed'))
          : 'failed';
        await supabase.from('upload_jobs').update({
          platform_results: pr,
          status: finalStatus,
          completed_at: new Date().toISOString(),
        }).eq('id', stale.id);

        await notifyTelegram(
          `⏱ <b>Job timed out</b>\n📹 ${stale.title || stale.video_file_name}\n` +
          pr.map((p: any) => `${p.name}: ${p.status === 'success' ? '✅' : '❌'} ${p.error || ''}`).join('\n')
        );
      }
    }
  }

  // Fetch pending jobs
  const { data: jobs, error: jobsErr } = await supabase
    .from('upload_jobs')
    .select('*')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(5);

  if (jobsErr || !jobs || jobs.length === 0) {
    return new Response(JSON.stringify({ ok: true, processed: 0 }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  let totalProcessed = 0;

  for (const job of jobs) {
    const platformResults = (job.platform_results as any[]) || [];
    let hasError = false;

    // Update job status to uploading
    await supabase.from('upload_jobs').update({ status: 'uploading' }).eq('id', job.id);

    for (const pr of platformResults) {
      if (pr.status !== 'pending') continue;

      // Validate credentials exist for this platform before starting
      const platEmail = settings[`${pr.name}_email`] || '';
      const platPassword = settings[`${pr.name}_password`] || '';
      const platEnabled = settings[`${pr.name}_enabled`];

      if (!platEnabled) {
        pr.status = 'error';
        pr.error = `${pr.name} is not enabled. Enable it in Settings first.`;
        await supabase.from('upload_jobs').update({ platform_results: platformResults }).eq('id', job.id);
        hasError = true;
        continue;
      }

      if (!platEmail || !platPassword) {
        pr.status = 'error';
        pr.error = `${pr.name} credentials missing. Add email and password in Settings before uploading.`;
        await supabase.from('upload_jobs').update({ platform_results: platformResults }).eq('id', job.id);
        hasError = true;
        continue;
      }

      pr.status = 'uploading';
      await supabase.from('upload_jobs').update({ platform_results: platformResults }).eq('id', job.id);

      try {
        let uploadUrl = '';

        if (uploadMode === 'cloud') {
          // Use Browserbase cloud browser with timeout
          const controller = new AbortController();
          const fetchTimeout = setTimeout(() => controller.abort(), 540000); // 9 min timeout

          try {
            const cloudResp = await fetch(`${supabaseUrl}/functions/v1/cloud-browser-upload`, {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${supabaseKey}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                job_id: job.id,
                platform: pr.name,
                credentials: {
                  email: settings[`${pr.name}_email`] || '',
                  password: settings[`${pr.name}_password`] || '',
                },
              }),
              signal: controller.signal,
            });
            clearTimeout(fetchTimeout);

            const cloudData = await cloudResp.json();
            if (!cloudData.success) {
              throw new Error(cloudData.error || 'Cloud browser upload failed');
            }
            uploadUrl = cloudData.url || '';
          } catch (fetchErr: any) {
            clearTimeout(fetchTimeout);
            if (fetchErr.name === 'AbortError') {
              throw new Error('Cloud browser session timed out (9 min). The upload may still be running — check Browser Sessions.');
            }
            throw fetchErr;
          }
        } else {
          // Local mode — use API-based uploads
          if (pr.name === 'youtube' && settings.youtube_enabled) {
            uploadUrl = await uploadToYouTube(job, supabase, {
              clientId: settings.youtube_email,
              clientSecret: settings.youtube_password,
              refreshToken: YOUTUBE_REFRESH_TOKEN,
            });
          } else if (pr.name === 'tiktok' && settings.tiktok_enabled) {
            uploadUrl = await uploadToTikTok(job, supabase, {
              accessToken: settings.tiktok_email,
            });
          } else if (pr.name === 'instagram' && settings.instagram_enabled) {
            uploadUrl = await uploadToInstagram(job, supabase, {
              accessToken: settings.instagram_email,
              businessId: settings.instagram_password,
            });
          } else {
            throw new Error(`${pr.name} is not enabled or credentials missing. Configure in Settings.`);
          }
        }

        pr.status = 'success';
        pr.url = uploadUrl;
      } catch (e: any) {
        pr.status = 'error';
        pr.error = e.message || 'Upload failed';
        hasError = true;
      }

      // Always persist after each platform attempt
      await supabase.from('upload_jobs').update({ platform_results: platformResults }).eq('id', job.id);
    }

    // Compute final status
    const allDone = platformResults.every((p: any) => p.status === 'success' || p.status === 'error');
    const allSuccess = platformResults.every((p: any) => p.status === 'success');
    const anySuccess = platformResults.some((p: any) => p.status === 'success');
    const finalStatus = allDone
      ? (allSuccess ? 'completed' : (anySuccess ? 'partial' : 'failed'))
      : 'pending';

    await supabase.from('upload_jobs').update({
      platform_results: platformResults,
      status: finalStatus,
      completed_at: allDone ? new Date().toISOString() : null,
    }).eq('id', job.id);

    // Send final summary on Telegram
    if (allDone) {
      const summary = platformResults.map((p: any) => {
        if (p.status === 'success') return `✅ ${p.name}: uploaded${p.url ? ` — ${p.url}` : ''}`;
        return `❌ ${p.name}: ${p.error || 'failed'}`;
      }).join('\n');

      await notifyTelegram(
        `📋 <b>Upload Summary</b>\n📹 ${job.title || job.video_file_name}\n\n${summary}`
      );
    }

    totalProcessed++;
  }

  return new Response(JSON.stringify({ ok: true, processed: totalProcessed }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});

// --- YouTube Upload via Data API v3 ---
async function uploadToYouTube(
  job: any,
  supabase: any,
  creds: { clientId?: string; clientSecret?: string; refreshToken?: string }
) {
  if (!creds.clientId || !creds.clientSecret || !creds.refreshToken) {
    throw new Error('YouTube API credentials not configured. Add YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, and YOUTUBE_REFRESH_TOKEN in Settings.');
  }

  // Refresh access token
  const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      refresh_token: creds.refreshToken,
      grant_type: 'refresh_token',
    }),
  });

  if (!tokenResp.ok) {
    const err = await tokenResp.text();
    throw new Error(`YouTube token refresh failed: ${err}`);
  }

  const { access_token } = await tokenResp.json();

  // Download video from storage
  const videoBytes = await downloadFromStorage(supabase, job.video_storage_path);

  // Start resumable upload
  const initResp = await fetch(
    'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${access_token}`,
        'Content-Type': 'application/json',
        'X-Upload-Content-Type': 'video/*',
        'X-Upload-Content-Length': String(videoBytes.byteLength),
      },
      body: JSON.stringify({
        snippet: {
          title: job.title || 'Untitled Video',
          description: job.description || '',
          tags: job.tags || [],
          categoryId: '22',
        },
        status: {
          privacyStatus: 'public',
          selfDeclaredMadeForKids: false,
        },
      }),
    }
  );

  if (!initResp.ok) {
    const err = await initResp.text();
    throw new Error(`YouTube upload init failed [${initResp.status}]: ${err}`);
  }

  const uploadUrl = initResp.headers.get('location');
  if (!uploadUrl) throw new Error('YouTube did not return upload URL');

  // Upload video bytes
  const uploadResp = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'video/*' },
    body: videoBytes,
  });

  if (!uploadResp.ok) {
    const err = await uploadResp.text();
    throw new Error(`YouTube video upload failed [${uploadResp.status}]: ${err}`);
  }

  const videoData = await uploadResp.json();
  return `https://www.youtube.com/watch?v=${videoData.id}`;
}

// --- TikTok Upload via Content Posting API ---
async function uploadToTikTok(
  job: any,
  supabase: any,
  creds: { accessToken?: string; openId?: string }
) {
  if (!creds.accessToken) {
    throw new Error('TikTok API credentials not configured. Add TIKTOK_ACCESS_TOKEN in Settings.');
  }

  // Download video from storage
  const videoBytes = await downloadFromStorage(supabase, job.video_storage_path);

  // Get video public URL for TikTok to pull
  const { data: urlData } = supabase.storage.from('videos').getPublicUrl(job.video_storage_path);
  const videoPublicUrl = urlData.publicUrl;

  // Initialize upload via pull method
  const initResp = await fetch('https://open.tiktokapis.com/v2/post/publish/video/init/', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${creds.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      post_info: {
        title: job.title || 'Video',
        description: `${job.description || ''} ${(job.tags || []).map((t: string) => `#${t}`).join(' ')}`.trim(),
        privacy_level: 'PUBLIC_TO_EVERYONE',
        disable_comment: false,
        disable_duet: false,
        disable_stitch: false,
      },
      source_info: {
        source: 'PULL_FROM_URL',
        video_url: videoPublicUrl,
      },
    }),
  });

  if (!initResp.ok) {
    const err = await initResp.text();
    throw new Error(`TikTok upload failed [${initResp.status}]: ${err}`);
  }

  const data = await initResp.json();
  const publishId = data.data?.publish_id;
  return publishId ? `https://www.tiktok.com/@user/video/${publishId}` : 'https://www.tiktok.com';
}

// --- Instagram Upload via Graph API ---
async function uploadToInstagram(
  job: any,
  supabase: any,
  creds: { accessToken?: string; businessId?: string }
) {
  if (!creds.accessToken || !creds.businessId) {
    throw new Error('Instagram API credentials not configured. Add INSTAGRAM_ACCESS_TOKEN and INSTAGRAM_BUSINESS_ID in Settings.');
  }

  // Get video public URL
  const { data: urlData } = supabase.storage.from('videos').getPublicUrl(job.video_storage_path);
  const videoPublicUrl = urlData.publicUrl;

  const caption = `${job.title || ''}\n\n${job.description || ''}\n\n${(job.tags || []).map((t: string) => `#${t}`).join(' ')}`.trim();

  // Create media container (Reels)
  const containerResp = await fetch(
    `https://graph.facebook.com/v18.0/${creds.businessId}/media`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        media_type: 'REELS',
        video_url: videoPublicUrl,
        caption,
        access_token: creds.accessToken,
      }),
    }
  );

  if (!containerResp.ok) {
    const err = await containerResp.text();
    throw new Error(`Instagram container creation failed [${containerResp.status}]: ${err}`);
  }

  const containerData = await containerResp.json();
  const containerId = containerData.id;

  // Wait for processing (poll status)
  let ready = false;
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 3000));
    const statusResp = await fetch(
      `https://graph.facebook.com/v18.0/${containerId}?fields=status_code&access_token=${creds.accessToken}`
    );
    const statusData = await statusResp.json();
    if (statusData.status_code === 'FINISHED') {
      ready = true;
      break;
    }
    if (statusData.status_code === 'ERROR') {
      throw new Error('Instagram video processing failed');
    }
  }

  if (!ready) throw new Error('Instagram video processing timed out');

  // Publish
  const publishResp = await fetch(
    `https://graph.facebook.com/v18.0/${creds.businessId}/media_publish`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        creation_id: containerId,
        access_token: creds.accessToken,
      }),
    }
  );

  if (!publishResp.ok) {
    const err = await publishResp.text();
    throw new Error(`Instagram publish failed [${publishResp.status}]: ${err}`);
  }

  const publishData = await publishResp.json();
  return `https://www.instagram.com/reel/${publishData.id}/`;
}

// --- Helper: Download video from Supabase Storage ---
async function downloadFromStorage(supabase: any, storagePath: string): Promise<ArrayBuffer> {
  if (!storagePath) throw new Error('No video file stored');

  const { data, error } = await supabase.storage.from('videos').download(storagePath);
  if (error || !data) throw new Error(`Failed to download video: ${error?.message || 'unknown'}`);

  return await data.arrayBuffer();
}
