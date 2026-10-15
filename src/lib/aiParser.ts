import { NavSite, ServerDeployment, SecretItem, QuickNote, AiConfig } from '../types';
import { createMaskedPreview, encryptText } from './crypto';

export interface ParsedEntities {
  sites: Partial<NavSite>[];
  servers: Partial<ServerDeployment>[];
  secrets: {
    name: string;
    category: 'api_key' | 'ssh_key' | 'db_credential' | 'token' | 'other';
    rawValue: string;
    description: string;
    tags: string[];
  }[];
  notes: Partial<QuickNote>[];
}

/**
 * High-speed local heuristic rule engine
 * Works 100% offline without needing any AI API Key
 */
export function parseTextLocally(rawText: string): ParsedEntities {
  const lines = rawText.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const result: ParsedEntities = {
    sites: [],
    servers: [],
    secrets: [],
    notes: []
  };

  const processedLines = new Set<number>();

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
        status: 'online',
        createdAt: Date.now()
      });
      processedLines.add(idx);
    }
  });

  // 3. Detect Websites and URLs
  const urlPattern = /(https?:\/\/[^\s]+)/g;
  lines.forEach((line, idx) => {
    if (processedLines.has(idx)) return;

    const urls = line.match(urlPattern);
    if (urls && urls.length > 0) {
      for (const urlStr of urls) {
        try {
          const u = new URL(urlStr);
          let title = line.replace(urlStr, '').trim();
          if (!title || title.length > 40) {
            title = u.hostname;
          }
          result.sites.push({
            id: `site-${Date.now()}-${idx}`,
            title,
            url: urlStr,
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

    if (config.provider === 'gemini') {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${config.model || 'gemini-2.5-flash'}:generateContent?key=${config.apiKey}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.1,
            responseMimeType: 'application/json'
          }
        })
      });
      if (!res.ok) {
        throw new Error(`Gemini API Error: ${res.statusText}`);
      }
      const data = await res.json();
      responseText = data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
    } else {
      // OpenAI / DeepSeek compatible
      const endpoint = config.baseUrl ? `${config.baseUrl.replace(/\/$/, '')}/chat/completions` : 'https://api.openai.com/v1/chat/completions';
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.apiKey}`
        },
        body: JSON.stringify({
          model: config.model || (config.provider === 'deepseek' ? 'deepseek-chat' : 'gpt-4o-mini'),
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.1,
          response_format: { type: 'json_object' }
        })
      });
      if (!res.ok) {
        throw new Error(`AI API Error: ${res.statusText}`);
      }
      const data = await res.json();
      responseText = data.choices?.[0]?.message?.content || '{}';
    }

    // Clean up code fences if present
    const cleanJson = responseText.replace(/```json/g, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(cleanJson);

    return {
      sites: Array.isArray(parsed.sites) ? parsed.sites : [],
      servers: Array.isArray(parsed.servers) ? parsed.servers : [],
      secrets: Array.isArray(parsed.secrets) ? parsed.secrets : [],
      notes: Array.isArray(parsed.notes) ? parsed.notes : []
    };
  } catch (err) {
    console.warn('AI Parsing failed, falling back to local heuristic parser', err);
    return parseTextLocally(rawText);
  }
}
