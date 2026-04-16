// Social Posts storage layer — multi-account, AI-powered post manager.
import { supabase } from '@/integrations/supabase/client';

export type SocialPlatform = 'x' | 'tiktok' | 'facebook';
export const SOCIAL_PLATFORMS: SocialPlatform[] = ['x', 'tiktok', 'facebook'];

export interface SocialAccount {
  id: string;
  platform: string;
  label: string;
  email: string;
  password: string;
  enabled: boolean;
  is_default: boolean;
  created_at: string;
}

export interface SocialPostResult {
  name: string;
  status: 'pending' | 'uploading' | 'success' | 'error';
  url?: string;
  error?: string;
}

export interface SocialPost {
  id: string;
  description: string;
  image_path: string | null;
  hashtags: string[];
  target_platforms: string[];
  status: string;
  scheduled_at: string | null;
  account_selections: Record<string, string>;
  ai_prompt: string | null;
  ai_sources: any[];
  platform_results: SocialPostResult[];
  created_at: string;
  completed_at: string | null;
}

export interface AISettings {
  provider: string;
  apiKey: string;
  model: string;
}

// --- AI settings (extended app_settings columns) ---
export async function getAISettings(): Promise<AISettings> {
  const { data } = await supabase.from('app_settings').select('*').eq('id', 1).single();
  const row = (data || {}) as any;
  return {
    provider: row.ai_provider || 'lovable',
    apiKey: row.ai_api_key || '',
    model: row.ai_model || 'google/gemini-3-flash-preview',
  };
}

export async function saveAISettings(s: AISettings): Promise<void> {
  const { error } = await supabase
    .from('app_settings')
    .update({ ai_provider: s.provider, ai_api_key: s.apiKey, ai_model: s.model } as any)
    .eq('id', 1);
  if (error) throw new Error(error.message);
}

// --- Social accounts ---
export async function getSocialAccounts(): Promise<SocialAccount[]> {
  const { data, error } = await (supabase as any)
    .from('social_post_accounts')
    .select('*')
    .order('created_at', { ascending: true });
  if (error || !data) return [];
  return data as SocialAccount[];
}

export async function saveSocialAccount(account: Partial<SocialAccount> & { platform: string }): Promise<SocialAccount> {
  if (account.id) {
    const { id, ...rest } = account;
    const { data, error } = await (supabase as any).from('social_post_accounts').update(rest).eq('id', id).select().single();
    if (error || !data) throw new Error(error?.message || 'Failed to update account');
    return data as SocialAccount;
  }
  const { data, error } = await (supabase as any).from('social_post_accounts').insert(account).select().single();
  if (error || !data) throw new Error(error?.message || 'Failed to create account');
  return data as SocialAccount;
}

export async function deleteSocialAccount(id: string): Promise<void> {
  const { error } = await (supabase as any).from('social_post_accounts').delete().eq('id', id);
  if (error) throw new Error(error.message);
}

export async function setDefaultSocialAccount(id: string, platform: string): Promise<void> {
  await (supabase as any).from('social_post_accounts').update({ is_default: false }).eq('platform', platform);
  await (supabase as any).from('social_post_accounts').update({ is_default: true }).eq('id', id);
}

// --- Image upload to social-media bucket ---
export async function uploadSocialImage(file: File): Promise<string> {
  const ext = file.name.split('.').pop() || 'png';
  const storagePath = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const { error } = await supabase.storage
    .from('social-media')
    .upload(storagePath, file, { cacheControl: '3600', upsert: false, contentType: file.type || 'image/png' });
  if (error) throw new Error(`Image upload failed: ${error.message}`);
  return storagePath;
}

export function getSocialImageUrl(storagePath: string | null): string | null {
  if (!storagePath) return null;
  const { data } = supabase.storage.from('social-media').getPublicUrl(storagePath);
  return data.publicUrl;
}

// --- Social posts ---
export async function listSocialPosts(): Promise<SocialPost[]> {
  const { data, error } = await (supabase as any)
    .from('social_posts')
    .select('*')
    .order('created_at', { ascending: false });
  if (error || !data) return [];
  return data.map((row: any) => ({
    ...row,
    hashtags: row.hashtags || [],
    target_platforms: row.target_platforms || [],
    account_selections: row.account_selections || {},
    ai_sources: row.ai_sources || [],
    platform_results: row.platform_results || [],
  })) as SocialPost[];
}

export async function createSocialPost(input: {
  description: string;
  imagePath: string | null;
  hashtags: string[];
  platforms: string[];
  accountSelections: Record<string, string>;
  scheduledAt?: string | null;
  aiPrompt?: string | null;
  aiSources?: any[];
}): Promise<SocialPost> {
  const platformResults: SocialPostResult[] = input.platforms.map((name) => ({ name, status: 'pending' }));
  const status = input.scheduledAt ? 'scheduled' : 'pending';
  const payload: any = {
    description: input.description,
    image_path: input.imagePath,
    hashtags: input.hashtags,
    target_platforms: input.platforms,
    account_selections: input.accountSelections,
    scheduled_at: input.scheduledAt || null,
    ai_prompt: input.aiPrompt || null,
    ai_sources: input.aiSources || [],
    status,
    platform_results: platformResults,
  };
  const { data, error } = await (supabase as any).from('social_posts').insert(payload).select().single();
  if (error || !data) throw new Error(error?.message || 'Failed to create post');
  return data as SocialPost;
}

export async function deleteSocialPost(id: string): Promise<void> {
  const { error } = await (supabase as any).from('social_posts').delete().eq('id', id);
  if (error) throw new Error(error.message);
}

export async function retrySocialPost(id: string): Promise<void> {
  const { data: post } = await (supabase as any).from('social_posts').select('*').eq('id', id).single();
  if (!post) return;
  const results = (post.platform_results || []) as SocialPostResult[];
  results.filter((r) => r.status === 'error').forEach((r) => { r.status = 'pending'; r.error = undefined; });
  await (supabase as any).from('social_posts').update({ status: 'pending', platform_results: results }).eq('id', id);
}

// --- AI generation ---
export interface AIGenerateInput {
  prompt: string;
  platforms: string[];
  includeImage: boolean;
}

export interface AIGenerateOutput {
  description: string;
  hashtags: string[];
  imageUrl: string | null;
  imagePath: string | null;
  sources: Array<{ title?: string; url?: string }>;
}

export async function generatePostWithAI(input: AIGenerateInput): Promise<AIGenerateOutput> {
  const { data, error } = await supabase.functions.invoke('generate-social-post', { body: input });
  if (error) throw new Error(error.message || 'AI generation failed');
  if (!data || data.error) throw new Error(data?.error || 'AI generation failed');
  return data as AIGenerateOutput;
}

export interface AIModel { id: string; label?: string }
export async function listAIModels(provider: string, apiKey: string): Promise<AIModel[]> {
  const { data, error } = await supabase.functions.invoke('list-ai-models', { body: { provider, apiKey } });
  if (error) throw new Error(error.message || 'Failed to list models');
  if (!data || data.error) throw new Error(data?.error || 'Failed to list models');
  return (data.models || []) as AIModel[];
}
