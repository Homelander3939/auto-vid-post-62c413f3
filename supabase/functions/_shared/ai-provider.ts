export const LOVABLE_GATEWAY = 'https://ai.gateway.lovable.dev/v1/chat/completions';
export const GOOGLE_OPENAI_GATEWAY = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';
export const DEFAULT_LOVABLE_MODEL = 'google/gemini-3-flash-preview';

export const LOVABLE_MODELS = [
  { id: DEFAULT_LOVABLE_MODEL, label: 'Gemini 3 Flash (preview) — default' },
  { id: 'google/gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro (preview)' },
  { id: 'google/gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
  { id: 'google/gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
  { id: 'google/gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash Lite' },
  { id: 'openai/gpt-5', label: 'GPT-5' },
  { id: 'openai/gpt-5-mini', label: 'GPT-5 Mini' },
  { id: 'openai/gpt-5-nano', label: 'GPT-5 Nano' },
  { id: 'openai/gpt-5.2', label: 'GPT-5.2' },
] as const;

const LOVABLE_ALLOWED_MODELS = new Set<string>(LOVABLE_MODELS.map((model) => model.id));

export interface ChatProviderConfigInput {
  provider?: string | null;
  apiKey?: string | null;
  model?: string | null;
  baseUrl?: string | null;
}

export interface ResolvedChatProviderConfig {
  requestedProvider: string;
  provider: 'lovable' | 'openai' | 'google' | 'nvidia' | 'openrouter' | 'xai' | 'lmstudio';
  url: string;
  key: string;
  model: string;
  googleMode: boolean;
  fallbackReason?: string;
}

export function normalizeGoogleChatModel(model: string): string {
  return String(model || '')
    .replace(/^models\//, '')
    .replace(/^google\//, '')
    .trim() || 'gemini-2.5-flash';
}

export function normalizeLovableModel(model: string): string {
  const normalized = String(model || '').trim();
  if (!normalized || !LOVABLE_ALLOWED_MODELS.has(normalized)) {
    return DEFAULT_LOVABLE_MODEL;
  }
  return normalized;
}

function normalizeProvider(provider?: string | null): string {
  return String(provider || 'lovable').trim().toLowerCase() || 'lovable';
}

export function resolveChatProviderConfig(
  chat: ChatProviderConfigInput,
  lovableKey: string,
): ResolvedChatProviderConfig {
  const provider = normalizeProvider(chat.provider);
  const apiKey = String(chat.apiKey || '').trim();
  const requestedModel = String(chat.model || '').trim();

  if (provider === 'openai' && apiKey) {
    return {
      requestedProvider: provider,
      provider: 'openai',
      url: 'https://api.openai.com/v1/chat/completions',
      key: apiKey,
      model: !requestedModel || requestedModel.startsWith('google/') ? 'gpt-4o-mini' : requestedModel,
      googleMode: false,
    };
  }

  if (provider === 'google' && apiKey) {
    return {
      requestedProvider: provider,
      provider: 'google',
      url: GOOGLE_OPENAI_GATEWAY,
      key: apiKey,
      model: normalizeGoogleChatModel(requestedModel),
      googleMode: true,
    };
  }

  if (provider === 'nvidia' && apiKey) {
    return {
      requestedProvider: provider,
      provider: 'nvidia',
      url: 'https://integrate.api.nvidia.com/v1/chat/completions',
      key: apiKey,
      model: requestedModel,
      googleMode: false,
    };
  }

  if (provider === 'openrouter' && apiKey) {
    return {
      requestedProvider: provider,
      provider: 'openrouter',
      url: 'https://openrouter.ai/api/v1/chat/completions',
      key: apiKey,
      model: requestedModel,
      googleMode: false,
    };
  }

  if (provider === 'xai' && apiKey) {
    return {
      requestedProvider: provider,
      provider: 'xai',
      url: 'https://api.x.ai/v1/chat/completions',
      key: apiKey,
      model: requestedModel || 'grok-2-latest',
      googleMode: false,
    };
  }

  if (provider === 'lmstudio') {
    const trimmed = String(chat.baseUrl || '').trim().replace(/\/+$/, '');
    const isPrivate = !trimmed || /localhost|127\.0\.0\.1|192\.168\.|10\.|172\./i.test(trimmed);
    if (trimmed && !isPrivate) {
      const url = trimmed.endsWith('/v1') ? `${trimmed}/chat/completions` : `${trimmed}/v1/chat/completions`;
      return {
        requestedProvider: provider,
        provider: 'lmstudio',
        url,
        key: apiKey || 'lm-studio',
        model: requestedModel,
        googleMode: false,
      };
    }
    // Private/local LM Studio is unreachable from cloud — fall back to Lovable but tell the user.
    const model = normalizeLovableModel(requestedModel);
    return {
      requestedProvider: provider,
      provider: 'lovable',
      url: LOVABLE_GATEWAY,
      key: lovableKey,
      model,
      googleMode: false,
      fallbackReason: 'LM Studio is on a private network and unreachable from cloud edge functions; using Lovable instead. The local worker on your PC will use LM Studio directly.',
    };
  }

  let fallbackReason: string | undefined;
  if ((provider === 'anthropic') && apiKey) {
    fallbackReason = `${provider} falls back to Lovable for autonomous tool-calling, so the model must be Lovable-compatible.`;
  } else if (provider !== 'lovable' && !apiKey) {
    fallbackReason = `${provider} is selected but no saved API key is available, so the agent is using Lovable instead.`;
  } else if (provider !== 'lovable') {
    fallbackReason = `${provider} is not supported for the autonomous agent loop, so the agent is using Lovable instead.`;
  }

  const model = normalizeLovableModel(requestedModel);
  if (!fallbackReason && requestedModel && model !== requestedModel) {
    fallbackReason = `Configured model "${requestedModel}" is not supported by Lovable, so the agent is using ${model}.`;
  }

  return {
    requestedProvider: provider,
    provider: 'lovable',
    url: LOVABLE_GATEWAY,
    key: lovableKey,
    model,
    googleMode: false,
    fallbackReason,
  };
}
