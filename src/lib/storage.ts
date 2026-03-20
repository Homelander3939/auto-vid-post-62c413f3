// Storage layer — uses Supabase for persistence.
// Works in Lovable preview (online) and locally when pulled from GitHub.

import { supabase } from '@/integrations/supabase/client';

export interface AppSettings {
  folderPath: string;
  youtube: { email: string; password: string; enabled: boolean };
  tiktok: { email: string; password: string; enabled: boolean };
  instagram: { email: string; password: string; enabled: boolean };
  telegram: { botToken: string; chatId: string; enabled: boolean };
}

export interface VideoMetadata {
  title: string;
  description: string;
  tags: string[];
  platforms: string[];
}

export interface PlatformResult {
  name: string;
  status: 'pending' | 'uploading' | 'success' | 'error';
  url?: string;
  error?: string;
}

export interface UploadJob {
  id: string;
  video_file_name: string;
  video_storage_path: string | null;
  title: string;
  description: string;
  tags: string[];
  target_platforms: string[];
  status: string;
  platform_results: PlatformResult[];
  created_at: string;
  completed_at: string | null;
}

export interface ScheduleConfig {
  enabled: boolean;
  cronExpression: string;
  platforms: string[];
}

export interface ScheduledUpload {
  id: string;
  video_file_name: string;
  video_storage_path: string | null;
  title: string;
  description: string;
  tags: string[];
  target_platforms: string[];
  scheduled_at: string;
  status: string;
  upload_job_id: string | null;
  created_at: string;
}

const defaultSettings: AppSettings = {
  folderPath: '',
  youtube: { email: '', password: '', enabled: false },
  tiktok: { email: '', password: '', enabled: false },
  instagram: { email: '', password: '', enabled: false },
  telegram: { botToken: '', chatId: '', enabled: false },
};

// --- Settings ---
export async function getSettings(): Promise<AppSettings> {
  const { data, error } = await supabase
    .from('app_settings')
    .select('*')
    .eq('id', 1)
    .single();

  if (error || !data) return defaultSettings;

  return {
    folderPath: data.folder_path,
    youtube: { email: data.youtube_email, password: data.youtube_password, enabled: data.youtube_enabled },
    tiktok: { email: data.tiktok_email, password: data.tiktok_password, enabled: data.tiktok_enabled },
    instagram: { email: data.instagram_email, password: data.instagram_password, enabled: data.instagram_enabled },
    telegram: { botToken: data.telegram_bot_token, chatId: data.telegram_chat_id, enabled: data.telegram_enabled },
  };
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  await supabase
    .from('app_settings')
    .update({
      folder_path: settings.folderPath,
      youtube_email: settings.youtube.email,
      youtube_password: settings.youtube.password,
      youtube_enabled: settings.youtube.enabled,
      tiktok_email: settings.tiktok.email,
      tiktok_password: settings.tiktok.password,
      tiktok_enabled: settings.tiktok.enabled,
      instagram_email: settings.instagram.email,
      instagram_password: settings.instagram.password,
      instagram_enabled: settings.instagram.enabled,
      telegram_bot_token: settings.telegram.botToken,
      telegram_chat_id: settings.telegram.chatId,
      telegram_enabled: settings.telegram.enabled,
    })
    .eq('id', 1);
}

// --- Video file upload to storage ---
export async function uploadVideoFile(file: File): Promise<string> {
  const ext = file.name.split('.').pop() || 'mp4';
  const storagePath = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;

  const { error } = await supabase.storage
    .from('videos')
    .upload(storagePath, file);

  if (error) throw new Error(`Upload failed: ${error.message}`);
  return storagePath;
}

export function getVideoUrl(storagePath: string): string {
  const { data } = supabase.storage.from('videos').getPublicUrl(storagePath);
  return data.publicUrl;
}

// --- Text file parsing ---
export function parseTextContent(content: string): VideoMetadata {
  const lines = content.split('\n').map((l) => l.trim()).filter(Boolean);
  const metadata: VideoMetadata = {
    title: '',
    description: '',
    tags: [],
    platforms: ['youtube', 'tiktok', 'instagram'],
  };

  for (const line of lines) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.substring(0, colonIdx).trim().toLowerCase();
    const value = line.substring(colonIdx + 1).trim();

    switch (key) {
      case 'title':
        metadata.title = value;
        break;
      case 'description':
        metadata.description = value;
        break;
      case 'tags':
      case 'keywords':
      case 'hashtags':
        metadata.tags = value.split(',').map((t) => t.trim()).filter(Boolean);
        break;
      case 'platforms':
        metadata.platforms = value.split(',').map((p) => p.trim().toLowerCase()).filter(Boolean);
        break;
    }
  }

  return metadata;
}

// --- Upload Jobs ---
export async function getQueue(): Promise<UploadJob[]> {
  const { data, error } = await supabase
    .from('upload_jobs')
    .select('*')
    .order('created_at', { ascending: false });

  if (error || !data) return [];
  return data.map((row) => ({
    ...row,
    platform_results: (row.platform_results as any) || [],
  }));
}

export async function createUploadJob(
  videoFileName: string,
  videoStoragePath: string | null,
  metadata: VideoMetadata,
  platforms: string[]
): Promise<UploadJob> {
  const platformResults: PlatformResult[] = platforms.map((name) => ({
    name,
    status: 'pending' as const,
  }));

  const { data, error } = await supabase
    .from('upload_jobs')
    .insert({
      video_file_name: videoFileName,
      video_storage_path: videoStoragePath,
      title: metadata.title,
      description: metadata.description,
      tags: metadata.tags,
      target_platforms: platforms,
      status: 'pending',
      platform_results: platformResults as any,
    })
    .select()
    .single();

  if (error || !data) throw new Error(error?.message || 'Failed to create job');

  return { ...data, platform_results: platformResults };
}

export async function updateJobPlatformResults(
  jobId: string,
  platformResults: PlatformResult[],
  status?: string,
  completedAt?: string
): Promise<void> {
  const updates: any = { platform_results: platformResults };
  if (status) updates.status = status;
  if (completedAt) updates.completed_at = completedAt;

  await supabase.from('upload_jobs').update(updates).eq('id', jobId);
}

// No fake simulation. Jobs stay "pending" until the local Node.js server
// picks them up and performs real Playwright browser uploads.

export async function retryJob(jobId: string): Promise<void> {
  const { data: job } = await supabase
    .from('upload_jobs')
    .select('*')
    .eq('id', jobId)
    .single();

  if (!job) return;

  const results = (job.platform_results as any as PlatformResult[]) || [];
  results.filter((r) => r.status === 'error').forEach((r) => {
    r.status = 'pending';
    r.error = undefined;
  });

  await updateJobPlatformResults(jobId, results, 'pending');
}

export async function deleteJob(jobId: string): Promise<void> {
  await supabase.from('upload_jobs').delete().eq('id', jobId);
}

export async function clearQueue(): Promise<void> {
  await supabase.from('upload_jobs').delete().neq('id', '00000000-0000-0000-0000-000000000000');
}

// --- Schedule ---
export async function getSchedule(): Promise<ScheduleConfig> {
  const { data, error } = await supabase
    .from('schedule_config')
    .select('*')
    .eq('id', 1)
    .single();

  if (error || !data) return { enabled: false, cronExpression: '0 9 * * *', platforms: ['youtube', 'tiktok', 'instagram'] };

  return {
    enabled: data.enabled,
    cronExpression: data.cron_expression,
    platforms: data.platforms,
  };
}

export async function saveSchedule(config: ScheduleConfig): Promise<void> {
  await supabase
    .from('schedule_config')
    .update({
      enabled: config.enabled,
      cron_expression: config.cronExpression,
      platforms: config.platforms,
    })
    .eq('id', 1);
}

// --- Scheduled Uploads ---
export async function getScheduledUploads(): Promise<ScheduledUpload[]> {
  const { data, error } = await supabase
    .from('scheduled_uploads')
    .select('*')
    .order('scheduled_at', { ascending: true });

  if (error || !data) return [];
  return data as ScheduledUpload[];
}

export async function createScheduledUpload(
  videoFileName: string,
  videoStoragePath: string | null,
  metadata: VideoMetadata,
  platforms: string[],
  scheduledAt: string
): Promise<ScheduledUpload> {
  const { data, error } = await supabase
    .from('scheduled_uploads')
    .insert({
      video_file_name: videoFileName,
      video_storage_path: videoStoragePath,
      title: metadata.title,
      description: metadata.description,
      tags: metadata.tags,
      target_platforms: platforms,
      scheduled_at: scheduledAt,
      status: 'scheduled',
    })
    .select()
    .single();

  if (error || !data) throw new Error(error?.message || 'Failed to create scheduled upload');
  return data as ScheduledUpload;
}

export async function deleteScheduledUpload(id: string): Promise<void> {
  await supabase.from('scheduled_uploads').delete().eq('id', id);
}
