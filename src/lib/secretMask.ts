/**
 * Credential detection and masking.
 * The AI ingest feature is built to pull API keys and passwords out of pasted
 * text. When cloud AI is on, that text goes to a third party — so we mask the
 * · sees the *shape* of the content (enough to classify it) but never the secret.
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

/**
 * Placeholder inserted in place of a masked value.
 * `kind` may contain Chinese ("疑似令牌"). The previous sanitisation at the call
 * site used `/[^\w]/g`, which strips every Chinese character and produced
 */
function placeholderFor(kind: string, index: number): string {
  const safe = kind.replace(/[^\w\u4e00-\u9fff]/g, '');
  return `⟪SH_MASKED_${safe}_${index}⟫`;
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
      const placeholder = placeholderFor(pattern.kind, index);
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

  // Second pass: unlabelled high-entropy tokens.
  masked = maskOpaqueTokens(masked, findings, values);

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

/* -------------------------------------------------------------------------- */
/* Entropy-based detection for unlabelled tokens                               */
/* -------------------------------------------------------------------------- */

/** Shannon entropy in bits per character. */
export function shannonEntropy(value: string): number {
  const counts = new Map<string, number>();
  for (const ch of value) counts.set(ch, (counts.get(ch) || 0) + 1);
  const len = value.length;
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / len;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/**
 * Looks like a machine-generated secret?
 *
 * Heuristic, deliberately conservative: a false positive replaces real text with
 * a placeholder (the user can also see the mask report), while a false negative
 * leaks a credential. We still require several independent signals so ordinary
 * prose, URLs and file names are not touched.
 */
export function looksLikeOpaqueToken(value: string): boolean {
  if (value.length < 20 || value.length > 200) return false;

  // Must mix letters and digits — that alone excludes normal English words.
  const hasLetter = /[A-Za-z]/.test(value);
  const hasDigit = /[0-9]/.test(value);
  if (!hasLetter || !hasDigit) return false;

  // Uniform case (all lower or all upper) is usually an identifier, not a token.
  const hasUpper = /[A-Z]/.test(value);
  const hasLower = /[a-z]/.test(value);
  const mixedCase = hasUpper && hasLower;

  // URLs and paths are not secrets.
  if (/^(https?|ftp|file):\/\//i.test(value)) return false;
  if (value.includes('/') && (value.includes('.'))) return false;

  // Long hex blobs (git SHAs, content hashes) are harmless but also not worth
  // sending; mask them only when they are long enough to be a key.
  const isHex = /^[0-9a-f]+$/i.test(value);

  if (isHex) return value.length >= 32;

  // base64-ish / url-safe alphabets
  const allowed = /^[A-Za-z0-9_\-+/=.~]+$/;
  if (!allowed.test(value)) return false;

  const entropy = shannonEntropy(value);
  // Random tokens sit around 4-5.5 bits/char; English words around 3.
  if (mixedCase && entropy >= 3.4) return true;
  if (!mixedCase && entropy >= 4.2 && value.length >= 24) return true;

  return false;
}

/**
 * Second pass: catch opaque tokens that carry no label at all.
 *
 * Runs after the labelled patterns so anything already masked is untouched
 * (placeholders contain `⟪`/`⟫`, which fail the alphabet check).
 */
function maskOpaqueTokens(text: string, findings: MaskFinding[], values: Record<string, string>): string {
  return text.replace(/[A-Za-z0-9_\-+/=.]{20,200}/g, (candidate) => {
    if (!looksLikeOpaqueToken(candidate)) return candidate;
    const index = findings.length;
    const placeholder = placeholderFor('疑似令牌', index);
    values[placeholder] = candidate;
    findings.push({ kind: '疑似令牌', preview: previewOf(candidate), length: candidate.length });
    return placeholder;
  });
}
