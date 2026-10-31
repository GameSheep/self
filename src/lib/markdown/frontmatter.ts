/**
 * YAML frontmatter handling.
 * marked has no frontmatter support: `---\ntitle: x\n---` is lexed as an <hr>
 * plus a setext heading. We therefore strip it before lexing and render it the
 * · Only the simple YAML subset that notes actually use is parsed. Anything else
 */

export interface FrontmatterField {
  key: string;
  value: string;
  /** List values render as chips. */
  list?: string[];
}

export interface FrontmatterResult {
  body: string;
  fields: FrontmatterField[];
  /** Raw frontmatter text (without the `---` fences). */
  raw: string;
  parsed: boolean;
}

const FENCE = /^---\s*$/;

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1).replace(/\\"/g, '"');
    }
  }
  return trimmed;
}

function parseInlineList(value: string): string[] | null {
  const m = /^\[(.*)\]$/.exec(value.trim());
  if (!m) return null;
  const inner = m[1].trim();
  if (!inner) return [];
  return inner.split(',').map((part) => unquote(part)).filter((part) => part.length > 0);
}

/**
 * Split leading frontmatter from the markdown body.
 * Returns `frontmatter: null` when the document does not start with a fence.
 */
export function splitFrontmatter(markdown: string): { frontmatter: FrontmatterResult | null; body: string } {
  const normalized = markdown.replace(/^\uFEFF/, '');
  const lines = normalized.split('\n');
  if (lines.length === 0 || !FENCE.test(lines[0])) {
    return { frontmatter: null, body: markdown };
  }

  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (FENCE.test(lines[i]) || /^\.\.\.\s*$/.test(lines[i])) {
      end = i;
      break;
    }
  }
  if (end === -1) {
    // Unterminated fence: not frontmatter, leave the document untouched.
    return { frontmatter: null, body: markdown };
  }

  const raw = lines.slice(1, end).join('\n');
  const body = lines.slice(end + 1).join('\n');

  const fields: FrontmatterField[] = [];
  let parsed = true;
  let pendingListKey: string | null = null;

  for (const line of raw.split('\n')) {
    if (!line.trim() || /^\s*#/.test(line)) continue;

    const listItem = /^\s*-\s+(.*)$/.exec(line);
    if (listItem && pendingListKey) {
      const field = fields[fields.length - 1];
      if (field && field.key === pendingListKey) {
        field.list = [...(field.list || []), unquote(listItem[1])];
        field.value = (field.list || []).join(', ');
        continue;
      }
    }

    const kv = /^([^:\s][^:]*):\s*(.*)$/.exec(line);
    if (!kv) {
      parsed = false;
      continue;
    }
    const key = kv[1].trim();
    const rawValue = kv[2];
    const inlineList = parseInlineList(rawValue);
    if (inlineList) {
      fields.push({ key, value: inlineList.join(', '), list: inlineList });
      pendingListKey = null;
    } else if (rawValue.trim() === '') {
      fields.push({ key, value: '' });
      pendingListKey = key;
    } else {
      fields.push({ key, value: unquote(rawValue) });
      pendingListKey = null;
    }
  }

  return {
    frontmatter: { body, fields, raw, parsed },
    body
  };
}
