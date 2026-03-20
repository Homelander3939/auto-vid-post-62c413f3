const API_BASE = 'http://localhost:3001/api';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ message: res.statusText }));
    throw new Error(err.message || res.statusText);
  }
  return res.json();
}

export const api = {
  // Settings
  getSettings: () => request<AppSettings>('/settings'),
  saveSettings: (settings: AppSettings) =>
    request<AppSettings>('/settings', { method: 'POST', body: JSON.stringify(settings) }),

  // Folder scan
  scanFolder: () => request<ScanResult>('/scan'),

  // Upload
  triggerUpload: (platforms: string[]) =>
    request<UploadJob>('/upload', { method: 'POST', body: JSON.stringify({ platforms }) }),

  // Queue
  getQueue: () => request<UploadJob[]>('/queue'),
  retryJob: (jobId: string) =>
    request<UploadJob>(`/queue/${jobId}/retry`, { method: 'POST' }),

  // Schedule
  getSchedule: () => request<ScheduleConfig>('/schedule'),
  saveSchedule: (config: ScheduleConfig) =>
    request<ScheduleConfig>('/schedule', { method: 'POST', body: JSON.stringify(config) }),

  // Health
  health: () => request<{ status: string }>('/health'),
};

export interface AppSettings {
  folderPath: string;
  youtube: { email: string; password: string; enabled: boolean };
  tiktok: { email: string; password: string; enabled: boolean };
  instagram: { email: string; password: string; enabled: boolean };
  telegram: { botToken: string; chatId: string; enabled: boolean };
}

export interface ScanResult {
  videoFile: string | null;
  textFile: string | null;
  metadata: {
    title: string;
    description: string;
    tags: string[];
    platforms: string[];
  } | null;
}

export interface UploadJob {
  id: string;
  videoFile: string;
  metadata: ScanResult['metadata'];
  platforms: { name: string; status: 'pending' | 'uploading' | 'success' | 'error'; url?: string; error?: string }[];
  createdAt: string;
  completedAt?: string;
}

export interface ScheduleConfig {
  enabled: boolean;
  cronExpression: string;
  platforms: string[];
}
