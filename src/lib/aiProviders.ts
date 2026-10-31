/**
 * Provider-specific request shapes.
 * These used to be one shared code path, which produced frequent 400s:
 * - the `model` field survived a provider switch, so Gemini was asked for
 */
import { AiConfig } from '../types';

export interface ProviderDefaults {
  defaultModel: string;
  endpoint: string;
  /** True when the provider accepts `response_format: json_object`. */
  supportsJsonMode: boolean;
}

const DEFAULTS: Record<AiConfig['provider'], ProviderDefaults> = {
  gemini: {
    defaultModel: 'gemini-2.5-flash',
    endpoint: 'https://generativelanguage.googleapis.com/v1beta',
    supportsJsonMode: false
  },
  deepseek: {
    defaultModel: 'deepseek-chat',
    endpoint: 'https://api.deepseek.com/v1',
    supportsJsonMode: true
  },
  openai: {
    defaultModel: 'gpt-4o-mini',
    endpoint: 'https://api.openai.com/v1',
    supportsJsonMode: true
  },
  custom: {
    defaultModel: 'gpt-4o-mini',
    endpoint: 'https://api.openai.com/v1',
    supportsJsonMode: true
  }
};

/** Does this model name look like it belongs to the provider? */
function modelBelongsToProvider(provider: AiConfig['provider'], model: string): boolean {
  if (!model) return false;
  switch (provider) {
    case 'gemini':
      return /^gemini/i.test(model);
    case 'deepseek':
      return /^deepseek/i.test(model);
    case 'openai':
      return /^(gpt|o[1-9]|text-embedding)/i.test(model);
    case 'custom':
      return true;
    default:
      return true;
  }
}

/**
 * Resolve the model to use.
 *
 * A model left over from another provider is the single most common cause of a
 * 400, so we fall back to the provider default instead of sending a name the API
 * cannot serve.
 */
export function resolveModel(config: AiConfig): { model: string; substituted: boolean } {
  const def = DEFAULTS[config.provider] || DEFAULTS.openai;
  const model = (config.model || '').trim();
  if (!model) return { model: def.defaultModel, substituted: true };
  if (!modelBelongsToProvider(config.provider, model)) {
    return { model: def.defaultModel, substituted: true };
  }
  return { model, substituted: false };
}

export function resolveEndpoint(config: AiConfig): string {
  const def = DEFAULTS[config.provider] || DEFAULTS.openai;
  const base = (config.baseUrl || '').trim().replace(/\/+$/, '');
  return base || def.endpoint;
}

function supportsJsonMode(config: AiConfig): boolean {
  return (DEFAULTS[config.provider] || DEFAULTS.openai).supportsJsonMode;
}

/**
 * Turn a provider response into a readable error.
 *
 * Reads the body (Gemini: `error.message`, OpenAI/DeepSeek: `error.message`) and
 * keeps the raw text as a last resort. Never invents a reason.
 */
export async function describeAiError(res: Response, provider: AiConfig['provider']): Promise<string> {
  let detail = '';
  try {
    const raw = await res.text();
    try {
      const json = JSON.parse(raw);
      detail = json?.error?.message || json?.message || '';
      // Gemini sometimes nests: error.details[].reason
      if (!detail && Array.isArray(json?.error?.details)) {
        detail = json.error.details.map((d: any) => d?.reason || '').filter(Boolean).join('; ');
      }
    } catch {
      detail = raw.slice(0, 300);
    }
  } catch {
    detail = '';
  }

  const head = `${provider} 返回 HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`;
  if (!detail) return head;
  return `${head}：${detail}`;
}

export function buildRequestBody(config: AiConfig, prompt: string, model: string): Record<string, unknown> {
  if (config.provider === 'gemini') {
    // Gemini takes contents[] and expresses JSON mode via responseMimeType.
    return {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.1, responseMimeType: 'application/json' }
    };
  }
  const body: Record<string, unknown> = {
    model,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.1
  };
  if (supportsJsonMode(config)) body.response_format = { type: 'json_object' };
  return body;
}

export { supportsJsonMode, modelBelongsToProvider };

/**
 * Human-readable explanation for a provider failure.
 *
 * Gemini reports an invalid key as HTTP 400 (not 401), which is why "400 every
 * time" usually means the key itself — not a malformed request.
 */
export function explainAiFailure(status: number, detail: string): string {
  const d = (detail || '').toLowerCase();
  if (d.includes('api_key_invalid') || d.includes('api key not valid')) {
    return 'API Key 无效。请确认：① Key 复制完整；② 该 Key 已启用 Generative Language API（Google AI Studio 里创建）；③ 没有 IP/来源限制。';
  }
  if (d.includes('permission_denied') || d.includes('not authorized')) {
    return '该 Key 无权访问此模型，请检查 Key 的项目权限与所用模型是否开通。';
  }
  if (d.includes('resource_exhausted') || d.includes('quota') || d.includes('rate limit')) {
    return '额度或频率超限，请稍后重试或更换 Key。';
  }
  if (d.includes('model not found') || d.includes('not found') || d.includes('unsupported model')) {
    return '模型名不存在或该账号不可用，请改用服务商支持的模型（例如 gemini-2.5-flash / deepseek-chat）。';
  }
  if (status === 401) return '认证失败（401）：Key 不正确或已被吊销。';
  if (status === 403) return '被拒绝（403）：Key 权限不足或所在地区/项目受限。';
  if (status === 404) return '端点不存在（404）：检查 Base URL 是否包含正确的版本前缀（如 /v1）。';
  if (status === 429) return '请求过于频繁（429），请稍后再试。';
  if (status >= 500) return `服务商故障（${status}），请稍后重试。`;
  return '';
}

export interface AiTestResult {
  ok: boolean;
  status?: number;
  message: string;
  /** Model actually used (after substituting an incompatible leftover name). */
  model: string;
  modelSubstituted: boolean;
  latencyMs?: number;
}

/**
 * Minimal round-trip used by the settings panel's "测试连接".
 *
 * Sends one short prompt so the user learns immediately whether the key, model
 * and endpoint actually work — instead of discovering it mid-ingest.
 */
export async function testAiProvider(config: AiConfig, timeoutMs = 20000): Promise<AiTestResult> {
  const { model, substituted } = resolveModel(config);
  const base = resolveEndpoint(config);
  const base64 = { model, modelSubstituted: substituted };

  if (!config.apiKey) {
    return { ok: false, message: '请先填写 API Key', ...base64 };
  }

  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  const started = Date.now();

  try {
    const url =
      config.provider === 'gemini'
        ? `${base}/models/${model}:generateContent?key=${encodeURIComponent(config.apiKey)}`
        : `${base}/chat/completions`;

    const body =
      config.provider === 'gemini'
        ? { contents: [{ parts: [{ text: '回复一个字：好' }] }], generationConfig: { temperature: 0 } }
        : { model, messages: [{ role: 'user', content: '回复一个字：好' }], temperature: 0, max_tokens: 8 };

    const res = await fetch(url, {
      method: 'POST',
      headers:
        config.provider === 'gemini'
          ? { 'Content-Type': 'application/json' }
          : { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify(body),
      signal: controller?.signal
    });

    const latencyMs = Date.now() - started;

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      let reason = detail.slice(0, 200);
      try {
        const json = JSON.parse(detail);
        reason = json?.error?.message || json?.error?.details?.[0]?.reason || reason;
      } catch {
        // keep raw text
      }
      const advice = explainAiFailure(res.status, detail);
      return {
        ok: false,
        status: res.status,
        model,
        modelSubstituted: substituted,
        latencyMs,
        message: `HTTP ${res.status}：${reason || '无返回内容'}${advice ? `\n→ ${advice}` : ''}`
      };
    }

    await res.json().catch(() => null);
    return {
      ok: true,
      status: res.status,
      model,
      modelSubstituted: substituted,
      latencyMs,
      message: `连接正常（${model}，${latencyMs}ms）`
    };
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError';
    return {
      ok: false,
      ...base64,
      message: aborted ? `超时（>${timeoutMs / 1000}s）` : `网络错误：${err instanceof Error ? err.message : String(err)}`
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
