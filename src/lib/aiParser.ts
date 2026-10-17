import { NavSite, ServerDeployment, SecretItem, QuickNote, AiConfig } from '../types';
import { createMaskedPreview, encryptText } from './crypto';
import { buildRequestBody, describeAiError, resolveEndpoint, resolveModel } from './aiProviders';

export interface ParsedSecret {
  name: string;
  category: 'api_key' | 'ssh_key' | 'db_credential' | 'token' | 'other';
  /** Plaintext value, present when the source contained a readable secret. */
  rawValue?: string;
  description?: string;
  tags?: string[];
  /** Present when the source is a Self-Hub export: ciphertext must be kept as-is. */
  encryptedValue?: string;
  iv?: string;
  salt?: string;
  maskedPreview?: string;
}

export interface ParsedEntities {
  sites: Partial<NavSite>[];
  servers: Partial<ServerDeployment>[];
  secrets: ParsedSecret[];
  notes: Partial<QuickNote>[];
  /** Which engine produced this result, so the UI can be honest about it. */
  engine?: 'llm' | 'local';
  /** Set when the cloud call failed and we fell back to local parsing. */
  warning?: string;
}

/**
 * Attempt to parse structured JSON exports (GoTab, Chrome Bookmarks, Self-Hub exports, generic arrays)
 * Delivers 100% lossless, pristine data extraction without any AI hallucination or text slicing.
 */
export function tryParseStructuredJson(rawText: string): ParsedEntities | null {
  const trimmed = rawText.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    return null;
  }

  try {
    const json = JSON.parse(trimmed);
    const result: ParsedEntities = {
      sites: [],
      servers: [],
      secrets: [],
      notes: []
    };

    // Case 1: GoTab 网站分类清单格式 (如 gotab-网站分类清单-20261016.json)
    if (json && Array.isArray(json.bookmarks)) {
      for (const bm of json.bookmarks) {
        if (bm && bm.url && typeof bm.url === 'string') {
          const rawUrl = bm.url.trim();
          let hostname = '';
          try { hostname = new URL(rawUrl).hostname; } catch (_) {}

          result.sites.push({
            id: `site-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            title: bm.name || bm.original_name || hostname || '未命名网站',
            url: rawUrl,
            category: bm.category || (Array.isArray(bm.origins) && bm.origins[0]) || 'GoTab导入',
            description: bm.original_name && bm.original_name !== bm.name ? `原名: ${bm.original_name}` : '',
            tags: Array.isArray(bm.origins) ? bm.origins : [],
            pinned: false,
            createdAt: Date.now()
          });
        }
      }

      // Also ingest GoTab note_links if present
      if (Array.isArray(json.note_links)) {
        for (const nl of json.note_links) {
          if (nl && nl.url && typeof nl.url === 'string') {
            const rawUrl = nl.url.trim();
            let hostname = '';
            try { hostname = new URL(rawUrl).hostname; } catch (_) {}

            result.sites.push({
              id: `site-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
              title: nl.name || hostname || '便签链接',
              url: rawUrl,
              category: nl.kind || '便签与脚本',
              description: Array.isArray(nl.origins) ? `来源便签: ${nl.origins.join(', ')}` : '',
              tags: Array.isArray(nl.origins) ? nl.origins : [],
              pinned: false,
              createdAt: Date.now()
            });
          }
        }
      }

      if (result.sites.length > 0) {
        return result;
      }
    }

    // Case 2: GoTab 原始备份格式 (gotab-data-*.json)
    const siteList = json.siteList || (json.data && json.data.siteList);
    if (Array.isArray(siteList)) {
      for (const item of siteList) {
        if (item && item.url) {
          result.sites.push({
            id: `site-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            title: item.title || item.name || item.url,
            url: item.url,
            category: item.category || item.group || 'GoTab导入',
            description: item.desc || item.description || '',
            tags: item.tags || [],
            pinned: Boolean(item.pinned),
            createdAt: Date.now()
          });
        }
      }
      if (result.sites.length > 0) return result;
    }

    // Case 3: Self-Hub 完整全量导出格式
    if (json.sites || json.servers || json.secrets || json.notes) {
      return {
        sites: Array.isArray(json.sites) ? json.sites : [],
        servers: Array.isArray(json.servers) ? json.servers : [],
        secrets: Array.isArray(json.secrets) ? json.secrets : [],
        notes: Array.isArray(json.notes) ? json.notes : []
      };
    }

    // Case 4: Chrome / Edge Bookmarks JSON 树形结构
    if (json.roots && (json.roots.bookmark_bar || json.roots.other)) {
      const traverseChrome = (node: any, folderName: string) => {
        if (!node) return;
        if (node.type === 'url' && node.url) {
          result.sites.push({
            id: `site-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            title: node.name || node.url,
            url: node.url,
            category: folderName || '浏览器书签',
            description: '',
            tags: ['Chrome书签'],
            pinned: false,
            createdAt: Date.now()
          });
        }
        if (Array.isArray(node.children)) {
          const currentFolder = node.name || folderName;
          node.children.forEach((child: any) => traverseChrome(child, currentFolder));
        }
      };

      if (json.roots.bookmark_bar) traverseChrome(json.roots.bookmark_bar, '书签栏');
      if (json.roots.other) traverseChrome(json.roots.other, '其他书签');
      if (result.sites.length > 0) return result;
    }

    // Case 5: 通用书签数组格式 [ { name/title, url, category }, ... ]
    const arr = Array.isArray(json) ? json : (Array.isArray(json.data) ? json.data : (Array.isArray(json.list) ? json.list : null));
    if (Array.isArray(arr) && arr.length > 0) {
      let matchedCount = 0;
      for (const item of arr) {
        if (item && (item.url || item.link || item.href)) {
          const targetUrl = item.url || item.link || item.href;
          let hostname = '';
          try { hostname = new URL(targetUrl).hostname; } catch (_) {}

          result.sites.push({
            id: `site-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            title: item.title || item.name || item.label || hostname || '书签',
            url: targetUrl,
            category: item.category || item.folder || item.tag || '导入书签',
            description: item.desc || item.description || '',
            tags: Array.isArray(item.tags) ? item.tags : [],
            pinned: false,
            createdAt: Date.now()
          });
          matchedCount++;
        }
      }
      if (matchedCount > 0) return result;
    }

    return null;
  } catch (_) {
    return null;
  }
}

/**
 * High-speed local heuristic rule engine
 * Works 100% offline without needing any AI API Key
 */
export function parseTextLocally(rawText: string): ParsedEntities {
  // Step 0: Auto-detect and parse structured JSON (GoTab, Chrome, SelfHub, etc.)
  const structured = tryParseStructuredJson(rawText);
  if (structured) {
    return structured;
  }

  const lines = rawText.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const result: ParsedEntities = {
    sites: [],
    servers: [],
    secrets: [],
    notes: []
  };

  const processedLines = new Set<number>();
  const seenUrls = new Set<string>();

  // 1. Detect API Keys & Secrets
  const apiKeyPatterns = [
    { regex: /(sk-[a-zA-Z0-9_-]{20,})/i, name: 'API Key (OpenAI/Compatible)' },
    { regex: /(AIzaSy[a-zA-Z0-9_-]{33})/i, name: 'Google Gemini API Key' },
    { regex: /(LTAI[a-zA-Z0-9]{16,24})/i, name: '阿里云 AccessKeyId' },
    { regex: /(ghp_[a-zA-Z0-9]{36})/i, name: 'GitHub Personal Token' },
    { regex: /(AKIA[0-9A-Z]{16})/i, name: 'AWS AccessKeyId' },
    { regex: /(api[-_]?key|secret|token|password|密码)[:=\s]+([^\s,;]+)/i, name: '凭据密钥' }
  ];

  lines.forEach((line, idx) => {
    for (const pat of apiKeyPatterns) {
      const match = line.match(pat.regex);
      if (match) {
        const rawValue = match[2] || match[1];
        if (rawValue && rawValue.length > 5) {
          result.secrets.push({
            name: `${pat.name} (${line.slice(0, 15)}...)`,
            category: 'api_key',
            rawValue,
            description: `提取自: ${line}`,
            tags: ['AI提取', '自动归类']
          });
          processedLines.add(idx);
          break;
        }
      }
    }
  });

  // 2. Detect Servers and IP / SSH Deployments
  const ipPattern = /\b(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\b/;
  const sshPattern = /ssh\s+([a-zA-Z0-9_-]+)@([^\s:]+)(?::(\d+))?/i;

  lines.forEach((line, idx) => {
    if (processedLines.has(idx)) return;

    const sshMatch = line.match(sshPattern);
    const ipMatch = line.match(ipPattern);

    if (sshMatch || ipMatch) {
      const ip = sshMatch ? sshMatch[2] : (ipMatch ? ipMatch[0] : '');
      const user = sshMatch ? sshMatch[1] : (line.includes('root') ? 'root' : 'admin');
      
      result.servers.push({
        id: `srv-${Date.now()}-${idx}`,
        name: line.length > 30 ? line.slice(0, 25) + '...' : line,
        publicIp: ip,
        port: 22,
        env: line.includes('测试') || line.includes('test') ? 'test' : 'prod',
        sshUser: user,
        sshCommand: `ssh ${user}@${ip}`,
        notes: line,
        status: 'unknown',
        createdAt: Date.now()
      });
      processedLines.add(idx);
    }
  });

  // 3. Detect Websites and URLs with sanitized URL regex
  const urlPattern = /https?:\/\/[^\s"'<>,;()]+/g;
  lines.forEach((line, idx) => {
    if (processedLines.has(idx)) return;

    const urls = line.match(urlPattern);
    if (urls && urls.length > 0) {
      for (const urlStr of urls) {
        const cleanUrl = urlStr.replace(/[.,;:"')]+$/, '').trim();
        if (!cleanUrl || seenUrls.has(cleanUrl)) continue;
        seenUrls.add(cleanUrl);

        try {
          const u = new URL(cleanUrl);
          // Clean up titles: strip JSON syntax like "url": " or "name": "
          let title = line.replace(cleanUrl, '');
          title = title.replace(/^["':\s,\-–—{}]+|["':\s,\-–—{}]+$/g, '').trim();
          if (title.startsWith('"url"') || title.startsWith('url:') || title === '"' || !title || title.length > 40) {
            title = u.hostname;
          }
          result.sites.push({
            id: `site-${Date.now()}-${idx}`,
            title,
            url: cleanUrl,
            category: 'AI整理导入',
            description: line.length > 60 ? line.slice(0, 60) + '...' : line,
            tags: [u.hostname],
            pinned: false,
            createdAt: Date.now()
          });
        } catch {
          // ignore invalid url
        }
      }
      processedLines.add(idx);
    }
  });

  // 4. Remaining lines as notes / snippets
  const remainingText = lines
    .filter((_, idx) => !processedLines.has(idx))
    .join('\n\n');

  if (remainingText.trim()) {
    result.notes.push({
      id: `note-${Date.now()}`,
      title: `快速导入笔记 (${new Date().toLocaleDateString()})`,
      content: remainingText,
      category: '杂乱备忘',
      pinned: false,
      updatedAt: Date.now()
    });
  }

  return result;
}

/**
 * LLM-Powered Semantic Entity Extraction
 * Calls Google Gemini / OpenAI / DeepSeek with structured prompt
 */
export async function parseTextWithLLM(rawText: string, config: AiConfig): Promise<ParsedEntities> {
  // Safety gate: pasted text routinely contains API keys and passwords. Nothing
  // leaves the device unless the user explicitly turned on cloud AI.
  if (!config?.apiKey || config.cloudAiEnabled !== true) {
    const local = parseTextLocally(rawText);
    return { ...local, engine: 'local' };
  }
  // Step 0: Check if it's already a clean structured JSON file (e.g. GoTab export)
  const structured = tryParseStructuredJson(rawText);
  if (structured) {
    return structured;
  }

  if (!config.apiKey) {
    return parseTextLocally(rawText);
  }

  const prompt = `你是一个高精度的个人资产与知识提取整理专家。请将用户从有道云笔记、微信收藏、剪贴板等杂乱平台复制的内容，精确分拣归类为以下四类资产，并以严格的 JSON 格式输出：
1. sites (网站与常用平台): 提取包含 url, title (中文友好名称), category (分类建议), description (简短描述)
2. servers (服务器与部署地址): 提取包含 name, domain, publicIp, port (数字, 默认22或80/443), env ('prod'|'test'|'dev'), sshUser, notes
3. secrets (敏感凭证如 API Key, SSH 密码, Token, AccessKey): 提取包含 name, category ('api_key'|'ssh_key'|'db_credential'|'token'|'other'), rawValue (必须保留原始秘钥字符), description, tags
4. notes (其他散落的知识、待办、备忘): 提取包含 title, content (Markdown格式), category

待整理的杂乱内容如下：
${rawText}

输出格式要求：必须仅输出合法的 JSON 对象，不要添加任何 markdown 代码块标记，不要包含 \`\`\`json 之外的文字：
{
  "sites": [...],
  "servers": [...],
  "secrets": [...],
  "notes": [...]
}`;

  try {
    let responseText = '';

    // Provider-correct model + endpoint: sending a leftover model name from
    // another provider is the most common cause of a 400 here.
    const { model } = resolveModel(config);
    const baseEndpoint = resolveEndpoint(config);
    const body = buildRequestBody(config, prompt, model);

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
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      // Read the body so the real reason (invalid model, quota, bad key) survives
      // into the UI instead of a blank statusText.
      throw new Error(await describeAiError(res, config.provider));
    }

    const data = await res.json();
    responseText =
      config.provider === 'gemini'
        ? data.candidates?.[0]?.content?.parts?.[0]?.text || '{}'
        : data.choices?.[0]?.message?.content || '{}';

    // Clean up code fences if present
    const cleanJson = responseText.replace(/```json/g, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(cleanJson);

    return {
      sites: Array.isArray(parsed.sites) ? parsed.sites : [],
      servers: Array.isArray(parsed.servers) ? parsed.servers : [],
      secrets: Array.isArray(parsed.secrets) ? parsed.secrets : [],
      notes: Array.isArray(parsed.notes) ? parsed.notes : []
    };
  } catch (err: any) {
    // Do not hide the failure: the caller shows this and the user can act on it
    // (wrong model, revoked key, quota). Silent fallback looked like success.
    console.warn('AI Parsing failed, falling back to local heuristic parser', err);
    const local = parseTextLocally(rawText);
    return { ...local, engine: 'local', warning: err?.message || '云端 AI 调用失败，已回退到本地规则' };
  }
}






