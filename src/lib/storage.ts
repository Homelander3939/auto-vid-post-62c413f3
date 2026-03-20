// Storage layer — works entirely in-browser via localStorage.
// When running locally with the Node.js server, the server handles actual uploads.
// This layer handles all CRUD so the UI works standalone in Lovable preview.

import { v4 as uuidv4 } from 'crypto';

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

export interface ScanResult {
  videoFile: string | null;
  textFile: string | null;
  metadata: VideoMetadata | null;
}

export interface PlatformStatus {
  name: string;
  status: 'pending' | 'uploading' | 'success' | 'error';
  url?: string;
  error?: string;
}

export interface UploadJob {
  id: string;
  videoFile: string;
  metadata: VideoMetadata | null;
  platforms: PlatformStatus[];
  createdAt: string;
  completedAt?: string;
}

export interface ScheduleConfig {
  enabled: boolean;
  cronExpression: string;
  platforms: string[];
}

const KEYS = {
  settings: 'vu_settings',
  queue: 'vu_queue',
  schedule: 'vu_schedule',
  demoFiles: 'vu_demo_files',
};

const defaultSettings: AppSettings = {
  folderPath: '',
  youtube: { email: '', password: '', enabled: false },
  tiktok: { email: '', password: '', enabled: false },
  instagram: { email: '', password: '', enabled: false },
  telegram: { botToken: '', chatId: '', enabled: false },
};

const defaultSchedule: ScheduleConfig = {
  enabled: false,
  cronExpression: '0 9 * * *',
  platforms: ['youtube', 'tiktok', 'instagram'],
};

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function write<T>(key: string, data: T): void {
  localStorage.setItem(key, JSON.stringify(data));
}

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// --- Settings ---
export function getSettings(): AppSettings {
  return read(KEYS.settings, defaultSettings);
}

export function saveSettings(settings: AppSettings): AppSettings {
  write(KEYS.settings, settings);
  return settings;
}

// --- Scan (demo mode) ---
export interface DemoFiles {
  videoFileName: string;
  textContent: string;
}

export function getDemoFiles(): DemoFiles | null {
  return read<DemoFiles | null>(KEYS.demoFiles, null);
}

export function setDemoFiles(files: DemoFiles): void {
  write(KEYS.demoFiles, files);
}

export function clearDemoFiles(): void {
  localStorage.removeItem(KEYS.demoFiles);
}

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

export function scanFolder(): ScanResult {
  const demo = getDemoFiles();
  if (!demo) {
    const settings = getSettings();
    if (settings.folderPath) {
      // In standalone mode we can't read the filesystem.
      // Return null to indicate "configure demo files or run locally"
      return { videoFile: null, textFile: null, metadata: null };
    }
    return { videoFile: null, textFile: null, metadata: null };
  }

  const metadata = parseTextContent(demo.textContent);
  return {
    videoFile: demo.videoFileName,
    textFile: demo.videoFileName.replace(/\.\w+$/, '.txt'),
    metadata,
  };
}

// --- Upload Queue ---
export function getQueue(): UploadJob[] {
  return read<UploadJob[]>(KEYS.queue, []);
}

function saveQueue(queue: UploadJob[]): void {
  write(KEYS.queue, queue);
}

export function createUploadJob(
  videoFile: string,
  metadata: VideoMetadata | null,
  platforms: string[]
): UploadJob {
  const job: UploadJob = {
    id: generateId(),
    videoFile,
    metadata,
    platforms: platforms.map((name) => ({ name, status: 'pending' })),
    createdAt: new Date().toISOString(),
  };

  const queue = getQueue();
  queue.unshift(job);
  saveQueue(queue);
  return job;
}

export function updateJobPlatformStatus(
  jobId: string,
  platformName: string,
  status: PlatformStatus['status'],
  extra?: { url?: string; error?: string }
): void {
  const queue = getQueue();
  const job = queue.find((j) => j.id === jobId);
  if (!job) return;

  const platform = job.platforms.find((p) => p.name === platformName);
  if (!platform) return;

  platform.status = status;
  if (extra?.url) platform.url = extra.url;
  if (extra?.error) platform.error = extra.error;
  if (status === 'error') platform.error = extra?.error || 'Unknown error';

  // Check if all done
  const allDone = job.platforms.every((p) => p.status === 'success' || p.status === 'error');
  if (allDone) job.completedAt = new Date().toISOString();

  saveQueue(queue);
}

export function simulateUpload(jobId: string): void {
  const queue = getQueue();
  const job = queue.find((j) => j.id === jobId);
  if (!job) return;

  // Simulate uploads with delays
  job.platforms.forEach((platform, i) => {
    if (platform.status !== 'pending') return;

    // Set to uploading
    setTimeout(() => {
      updateJobPlatformStatus(jobId, platform.name, 'uploading');
      window.dispatchEvent(new Event('queue-updated'));
    }, i * 1500 + 500);

    // Simulate completion (80% success, 20% error for realism)
    setTimeout(() => {
      const success = Math.random() > 0.2;
      if (success) {
        const urls: Record<string, string> = {
          youtube: 'https://youtube.com/watch?v=demo123',
          tiktok: 'https://tiktok.com/@user/video/demo123',
          instagram: 'https://instagram.com/reel/demo123',
        };
        updateJobPlatformStatus(jobId, platform.name, 'success', {
          url: urls[platform.name] || '#',
        });
      } else {
        updateJobPlatformStatus(jobId, platform.name, 'error', {
          error: 'Simulated error — will work with real server',
        });
      }
      window.dispatchEvent(new Event('queue-updated'));
    }, i * 1500 + 3000 + Math.random() * 2000);
  });
}

export function retryJob(jobId: string): void {
  const queue = getQueue();
  const job = queue.find((j) => j.id === jobId);
  if (!job) return;

  job.platforms
    .filter((p) => p.status === 'error')
    .forEach((p) => {
      p.status = 'pending';
      p.error = undefined;
    });
  job.completedAt = undefined;
  saveQueue(queue);
  simulateUpload(jobId);
}

export function clearQueue(): void {
  saveQueue([]);
}

// --- Schedule ---
export function getSchedule(): ScheduleConfig {
  return read(KEYS.schedule, defaultSchedule);
}

export function saveSchedule(config: ScheduleConfig): ScheduleConfig {
  write(KEYS.schedule, config);
  return config;
}

// --- Server check ---
export async function checkServer(): Promise<boolean> {
  try {
    const res = await fetch('http://localhost:3001/api/health', { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}
