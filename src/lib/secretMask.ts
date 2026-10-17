/**
 * Credential detection and masking.
 *
 * The AI ingest feature is built to pull API keys and passwords out of pasted
 * text. When cloud AI is on, that text goes to a third party — so we mask the
 * credentials first and re-hydrate the values locally afterwards. The model still
 * sees the *shape* of the content (enough to classify it) but never the secret.
 *
 * Patterns are deliberately high-confidence: a false positive silently destroys
 * content, which is worse than missing an unusual key format.
 */

export interface MaskFinding {
  kind: string;
  /** Short, safe preview: never the full secret. */
  preview: string;
  /** Number of characters replaced. */
  length: number;
}

export interface MaskResult {
  masked: string;
  findings: MaskFinding[];
  /** placeholder -> original value, used to restore raw values locally. */
  values: Record<string, string>;
}

function previewOf(value: string): string {
  const clean = value.replace(/\s+/g, '');
  if (clean.length <= 8) return '••••';
  return `${clean.slice(0, 4)}…${clean.slice(-2)}（${clean.length} 位）`;
}

function placeholderFor(kind: string, index: number): string {
  return `⟪SH_MASKED_${kind}_${index}⟫`;
}

interface Pattern {
  kind: string;
  regex: RegExp;
  /** Keep the match verbatim (e.g. PEM blocks contain newlines). */
  multiline?: boolean;
}

const PATTERNS: Pattern[] = [
  // Private keys: mask the whole block, it is all sensitive.
  { kind: '私钥', regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, multiline: true },
  { kind: '阿里云AccessKey', regex: /\bLTAI[A-Za-z0-9]{8,24}\b/g },
  { kind: 'OpenAI密钥', regex: /\bsk-[A-Za-z0-9_-]{16,}\b/g },
  { kind: 'Google密钥', regex: /\bAIza[0-9A-Za-z_-]{30,}\b/g },
  { kind: 'GitHub令牌', regex: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  { kind: 'AWS密钥', regex: /\bAKIA[0-9A-Z]{12,20}\b/g },
  { kind: 'Slack令牌', regex: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  { kind: 'JWT', regex: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { kind: 'Stripe密钥', regex: /\b[sr]k_(live|test)_[A-Za-z0-9]{16,}\b/g },
  { kind: '连接串凭据', regex: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s:@/]+@[^\s/]+/gi },
  // Labelled secrets: keep the label, mask the value.
  {
    kind: '密码',
    regex: /((?:password|passwd|pwd|密码)\s*[:=：]\s*)([^\s,;，。'"]{6,})/gi
  },
  {
    kind: '令牌',
    regex: /((?:token|api[_-]?key|apikey|secret|access[_-]?key[_-]?secret|密钥|令牌)\s*[:=：]\s*)([^\s,;，。'"]{8,})/gi
  }
];

/** Which capture group holds the secret (2 for labelled patterns, 0 otherwise). */
function secretGroup(kind: string): number {
  return kind === '密码' || kind === '令牌' ? 2 : 0;
}

/**
 * Find and replace credential-looking substrings.
 * Returns the masked text plus enough information to restore the values locally.
 */
export function maskSecrets(text: string): MaskResult {
  const findings: MaskFinding[] = [];
  const values: Record<string, string> = {};
  let masked = text;

  for (const pattern of PATTERNS) {
    const group = secretGroup(pattern.kind);
    // Rebuild the regex per call: a global regex keeps lastIndex between calls.
    const regex = new RegExp(pattern.regex.source, pattern.regex.flags);
    masked = masked.replace(regex, (match: string, ...args: unknown[]) => {
      // args layout: [g1, g2, ..., offset, wholeString]
      const captured = group > 0 ? String(args[group - 1] ?? '') : match;
      if (!captured) return match;

      const index = findings.length;
      const placeholder = placeholderFor(pattern.kind.replace(/[^\w]/g, ''), index);
      values[placeholder] = captured;
      findings.push({ kind: pattern.kind, preview: previewOf(captured), length: captured.length });

      if (group > 0) {
        // Keep the label ("password: ") and replace only the value.
        const prefix = match.slice(0, match.length - captured.length);
        return `${prefix}${placeholder}`;
      }
      return placeholder;
    });
  }

  return { masked, findings, values };
}

/**
 * Put real values back into anything the model returned.
 *
 * If the model echoed our placeholders (it usually does, since we ask it to keep
 * the text intact), the credential is restored locally without ever having been
 * transmitted.
 */
export function rehydrateValue(value: string | undefined, values: Record<string, string>): string | undefined {
  if (!value) return value;
  let out = value;
  for (const [placeholder, original] of Object.entries(values)) {
    if (out.includes(placeholder)) out = out.split(placeholder).join(original);
  }
  return out;
}

/** Human summary, e.g. "已遮蔽 2 处（阿里云AccessKey、密码）". */
export function describeFindings(findings: MaskFinding[]): string {
  if (findings.length === 0) return '';
  const kinds = Array.from(new Set(findings.map((f) => f.kind)));
  return `已遮蔽 ${findings.length} 处疑似凭据（${kinds.join('、')}）`;
}
