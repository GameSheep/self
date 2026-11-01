import type { AiConfig } from '../types';
import { buildRequestBody, describeAiError, resolveEndpoint, resolveModel } from '../lib/aiProviders';

/**
 * Optional cloud assist for the paste dialog (2).
 * Scope is deliberately tiny: **hostnames only**. The user's pasted text (which routinely
 * contains tokens and private URLs) never leaves the device. The call happens only when cloud
 */
export class CloudAiDisabledError extends Error {
  constructor() {
    super('云端 AI 未开启');
    this.name = 'CloudAiDisabledError';
  }
}

export interface ClassifyResult {
  categories: Record<string, string>;
  /** Hosts the model did not answer for; the caller keeps the local guess for these. */
  missing: string[];
}

export async function classifyHostsWithAi(
  hosts: string[],
  config: AiConfig,
  categories: string[]
): Promise<ClassifyResult> {
  if (!config?.apiKey || config.cloudAiEnabled !== true) throw new CloudAiDisabledError();
  const unique = Array.from(new Set(hosts.filter(Boolean)));
  if (unique.length === 0) return { categories: {}, missing: [] };

  const { model } = resolveModel(config);
  const baseEndpoint = resolveEndpoint(config);
  const prompt = `你是一个网站分类助手。只能看到域名，不要猜测页面内容。
用户已有的分类：${categories.filter((c) => c !== '全部').join('、') || '常用工具、技术开发、运维部署'}

请为每个域名给出一个分类，只能从上面的分类里选；无法判断时用第一个。
域名列表：
${unique.join('\n')}

只输出 JSON 对象，键是域名，值是分类名，不要任何其它文字：
{"example.com":"技术开发"}`;

  const url =
    config.provider === 'gemini'
      ? `${baseEndpoint}/models/${model}:generateContent?key=${encodeURIComponent(config.apiKey)}`
      : `${baseEndpoint}/chat/completions`;

  const res = await fetch(url, {
    method: 'POST',
    headers:
      config.provider === 'gemini'
        ? { 'Content-Type': 'application/json' }
        : { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
    body: JSON.stringify(buildRequestBody(config, prompt, model))
  });

  if (!res.ok) throw new Error(await describeAiError(res, config.provider));

  const data = await res.json();
  const text =
    config.provider === 'gemini'
      ? data?.candidates?.[0]?.content?.parts?.[0]?.text || '{}'
      : data?.choices?.[0]?.message?.content || '{}';

  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(String(text).replace(/```json/g, '').replace(/```/g, '').trim());
  } catch {
    throw new Error('云端返回的不是可解析的分类结果');
  }

  const allowed = new Set(categories.filter((c) => c !== '全部'));
  const result: Record<string, string> = {};
  const missing: string[] = [];
  for (const host of unique) {
    const value = parsed[host];
    if (typeof value === 'string' && (!allowed.size || allowed.has(value))) {
      result[host] = value;
    } else {
      missing.push(host);
    }
  }
  return { categories: result, missing };
}
