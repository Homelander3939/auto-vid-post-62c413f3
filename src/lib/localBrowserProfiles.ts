export interface LocalBrowserProfile {
  id: string;
  label: string;
  createdAt: string;
  lastOpenedAt: string | null;
}

export type PlatformAccountSelections = Record<string, string>;

const LOCAL_SERVER_URL = 'http://localhost:3001';

async function requestLocal<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${LOCAL_SERVER_URL}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers || {}),
    },
    ...init,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(text || `Local server request failed (${response.status})`);
  }

  return response.json() as Promise<T>;
}

export async function openLocalBrowserProfileSession(params: {
  platform: string;
  accountId?: string;
  profileId?: string;
  label?: string;
}): Promise<{ profile: LocalBrowserProfile; linkedAccountIds: string[] }> {
  return requestLocal('/api/browser-profiles/open', {
    method: 'POST',
    body: JSON.stringify(params),
  });
}

export async function saveLocalJobAccountSelections(jobId: string, selections: PlatformAccountSelections): Promise<void> {
  await requestLocal('/api/browser-profiles/job-selections', {
    method: 'POST',
    body: JSON.stringify({ jobId, selections }),
  });
}

export async function saveLocalScheduledAccountSelections(scheduledId: string, selections: PlatformAccountSelections): Promise<void> {
  await requestLocal('/api/browser-profiles/scheduled-selections', {
    method: 'POST',
    body: JSON.stringify({ scheduledId, selections }),
  });
}