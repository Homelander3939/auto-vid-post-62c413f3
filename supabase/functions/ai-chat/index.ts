import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

async function getAppContext(supabase: any): Promise<string> {
  const [
    { data: jobs },
    { data: scheduled },
    { data: settings },
    { data: scheduleConfig },
  ] = await Promise.all([
    supabase.from('upload_jobs').select('*').order('created_at', { ascending: false }).limit(20),
    supabase.from('scheduled_uploads').select('*').order('scheduled_at', { ascending: true }).limit(20),
    supabase.from('app_settings').select('*').eq('id', 1).single(),
    supabase.from('schedule_config').select('*').eq('id', 1).single(),
  ]);

  const pendingJobs = (jobs || []).filter((j: any) => j.status === 'pending');
  const processingJobs = (jobs || []).filter((j: any) => j.status === 'processing');
  const completedJobs = (jobs || []).filter((j: any) => j.status === 'completed');
  const failedJobs = (jobs || []).filter((j: any) => j.status === 'failed');

  const upcomingScheduled = (scheduled || []).filter((s: any) => s.status === 'scheduled');
  const completedScheduled = (scheduled || []).filter((s: any) => s.status === 'completed');

  const formatJob = (j: any) =>
    `  • "${j.title || j.video_file_name}" → ${j.target_platforms?.join(', ') || 'none'} | status: ${j.status} | created: ${new Date(j.created_at).toLocaleString()}${j.completed_at ? ` | completed: ${new Date(j.completed_at).toLocaleString()}` : ''}`;

  const formatScheduled = (s: any) =>
    `  • "${s.title || s.video_file_name}" → ${s.target_platforms?.join(', ') || 'none'} | scheduled: ${new Date(s.scheduled_at).toLocaleString()} | status: ${s.status}`;

  const platformStatus = [];
  if (settings) {
    if (settings.youtube_enabled) platformStatus.push(`YouTube (${settings.youtube_email || 'no email'})`);
    if (settings.tiktok_enabled) platformStatus.push(`TikTok (${settings.tiktok_email || 'no email'})`);
    if (settings.instagram_enabled) platformStatus.push(`Instagram (${settings.instagram_email || 'no email'})`);
    if (settings.telegram_enabled) platformStatus.push(`Telegram (chat: ${settings.telegram_chat_id || 'not set'})`);
  }

  const cronInfo = scheduleConfig?.data || scheduleConfig;
  const cronEnabled = cronInfo?.enabled ? 'ENABLED' : 'DISABLED';
  const cronExpr = cronInfo?.cron_expression || 'not set';
  const cronPlatforms = cronInfo?.platforms?.join(', ') || 'none';

  return `
=== LIVE APP DATA (real-time from database) ===

ENABLED PLATFORMS: ${platformStatus.length > 0 ? platformStatus.join(' | ') : 'None configured'}
WATCH FOLDER: ${settings?.folder_path || 'Not set'}

UPLOAD QUEUE SUMMARY:
- Pending: ${pendingJobs.length} jobs
- Processing: ${processingJobs.length} jobs  
- Completed: ${completedJobs.length} jobs
- Failed: ${failedJobs.length} jobs
- Total: ${(jobs || []).length} jobs

${pendingJobs.length > 0 ? `PENDING JOBS:\n${pendingJobs.map(formatJob).join('\n')}` : 'No pending jobs.'}
${processingJobs.length > 0 ? `\nPROCESSING NOW:\n${processingJobs.map(formatJob).join('\n')}` : ''}
${failedJobs.length > 0 ? `\nFAILED JOBS:\n${failedJobs.map(formatJob).join('\n')}` : ''}
${completedJobs.length > 0 ? `\nRECENT COMPLETED:\n${completedJobs.slice(0, 5).map(formatJob).join('\n')}` : ''}

SCHEDULED UPLOADS:
- Upcoming: ${upcomingScheduled.length}
- Completed: ${completedScheduled.length}
${upcomingScheduled.length > 0 ? `\nUPCOMING:\n${upcomingScheduled.map(formatScheduled).join('\n')}` : 'No upcoming scheduled uploads.'}

CRON SCHEDULE: ${cronEnabled} | Expression: ${cronExpr} | Platforms: ${cronPlatforms}

SETUP GUIDE:
1. Configure platform credentials in Settings
2. Set the watch folder path for local server
3. Install local server: run setup.bat then start.bat from the /server folder
4. The local server uses Playwright to automate browser uploads
5. Videos are queued in the cloud, local server picks them up and uploads via browser automation
===`;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const LOVABLE_API_KEY = Deno.env.get('LOVABLE_API_KEY');
    if (!LOVABLE_API_KEY) throw new Error('LOVABLE_API_KEY is not configured');

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const { messages } = await req.json();

    if (!messages || !Array.isArray(messages)) {
      return new Response(
        JSON.stringify({ error: 'messages array is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Fetch live app context
    const appContext = await getAppContext(supabase);

    const systemPrompt = `You are a helpful AI assistant integrated into the Video Uploader application. You have FULL ACCESS to the app's live data shown below.

${appContext}

You help users with:
- Checking their upload queue status, pending/completed/failed jobs (USE THE DATA ABOVE - don't say you can't access it!)
- Viewing scheduled uploads and campaign schedules
- Managing video uploads to YouTube, TikTok, and Instagram
- Writing video titles, descriptions, and tags
- Scheduling upload campaigns
- Troubleshooting upload errors
- Setup guidance for the local server and platform configuration
- General questions about content creation and social media strategy
- Analyzing images and files that users share with you

IMPORTANT: You HAVE access to the app data. When users ask about queued jobs, scheduled uploads, settings, etc., answer using the LIVE APP DATA above. Never say you don't have access to the data.

Be concise, friendly, and actionable. Use markdown formatting for better readability.
Format job lists as clean tables or bullet points.`;

    // Transform messages for multimodal support
    const transformedMessages = messages.map((msg: any) => {
      if (msg.role === 'system') return msg;
      
      if (msg.images && msg.images.length > 0) {
        const content: any[] = [];
        if (msg.content) content.push({ type: 'text', text: msg.content });
        for (const img of msg.images) {
          content.push({ type: 'image_url', image_url: { url: img.url } });
        }
        return { role: msg.role, content };
      }
      
      if (msg.files && msg.files.length > 0) {
        let fileContext = msg.content || '';
        for (const file of msg.files) {
          fileContext += `\n\n[Attached file: ${file.name} (${file.type}, ${file.size})]`;
          if (file.textContent) fileContext += `\nFile contents:\n\`\`\`\n${file.textContent}\n\`\`\``;
        }
        return { role: msg.role, content: fileContext };
      }
      
      return { role: msg.role, content: msg.content };
    });

    const hasImages = messages.some((m: any) => m.images && m.images.length > 0);
    const model = hasImages ? 'google/gemini-2.5-flash' : 'google/gemini-3-flash-preview';

    const response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          ...transformedMessages,
        ],
        stream: true,
      }),
    });

    if (!response.ok) {
      if (response.status === 429) {
        return new Response(JSON.stringify({ error: "Rate limit exceeded. Please try again in a moment." }), {
          status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (response.status === 402) {
        return new Response(JSON.stringify({ error: "AI credits exhausted. Add credits in Settings > Workspace > Usage." }), {
          status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const t = await response.text();
      console.error("AI gateway error:", response.status, t);
      return new Response(JSON.stringify({ error: "AI service error" }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(response.body, {
      headers: { ...corsHeaders, "Content-Type": "text/event-stream" },
    });
  } catch (e) {
    console.error("chat error:", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
