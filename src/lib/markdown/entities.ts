/**
 * Obsidian-specific inline entities: [[wikilinks]] and #tags.
 * These are resolved while rendering *plain text tokens* rather than by
 * pre-processing the raw markdown. marked consumes code spans, fenced code and
 * · a wikilink or tag can legally appear — this can never mangle `[[…]]` inside a
 */

export type InlineSegment =
  | { kind: 'text'; text: string }
  | { kind: 'wikilink'; target: string; alias: string; heading?: string }
  | { kind: 'tag'; tag: string };

/** `[[Note]]`, `[[Note|alias]]`, `[[Note#Heading]]`, `[[Note#Heading|alias]]` */
const WIKILINK = /\[\[([^\]\n]+?)\]\]/;
/** A tag must start a word and contain at least one non-punctuation char. */
const TAG = /(^|[\s(（[【>])#([\p{L}\p{N}_\-/]{1,64})/u;

function parseWikilink(inner: string): InlineSegment {
  const [targetPart, ...aliasParts] = inner.split('|');
  const alias = aliasParts.join('|').trim();
  const [target, ...headingParts] = targetPart.split('#');
  const heading = headingParts.join('#').trim();
  const cleanTarget = target.trim();
  return {
    kind: 'wikilink',
    target: cleanTarget,
    alias: alias || cleanTarget,
    heading: heading || undefined
  };
}

function isPlausibleTag(body: string): boolean {
  if (!body) return false;
  // Exclude things that are clearly not tags: color hex (#fff is a tag in
  // Obsidian, but `#123` issue refs are common noise — keep both, only reject
  // bodies made purely of separators).
  return /[\p{L}\p{N}]/u.test(body);
}

/**
 * Split a plain-text run into text / wikilink / tag segments.
 * Returns a single text segment when nothing matches (the common case).
 */
export function splitInlineEntities(text: string): InlineSegment[] {
  if (!text) return [];
  if (!text.includes('[[') && !text.includes('#')) return [{ kind: 'text', text }];

  const out: InlineSegment[] = [];
  let rest = text;

  while (rest.length > 0) {
    const wiki = WIKILINK.exec(rest);
    const tag = TAG.exec(rest);

    const wikiAt = wiki ? wiki.index : -1;
    // The tag regex captures a leading boundary char at index 0 of the match.
    const tagAt = tag ? tag.index + tag[1].length : -1;

    if (wikiAt === -1 && tagAt === -1) {
      out.push({ kind: 'text', text: rest });
      break;
    }

    const useWiki = wikiAt !== -1 && (tagAt === -1 || wikiAt <= tagAt);
    const at = useWiki ? wikiAt : tagAt;

    if (at > 0) out.push({ kind: 'text', text: rest.slice(0, at) });

    if (useWiki && wiki) {
      out.push(parseWikilink(wiki[1]));
      rest = rest.slice(at + wiki[0].length);
    } else if (tag) {
      const body = tag[2];
      if (isPlausibleTag(body)) {
        out.push({ kind: 'tag', tag: body });
      } else {
        out.push({ kind: 'text', text: `#${body}` });
      }
      rest = rest.slice(at + 1 + body.length);
    } else {
      out.push({ kind: 'text', text: rest.slice(at) });
      break;
    }
  }

  return out.length > 0 ? out : [{ kind: 'text', text }];
}

/** Strip a `#Heading` suffix and any `|alias` from a raw wikilink target. */
export function normalizeWikilinkTarget(target: string): string {
  return target.split('|')[0].split('#')[0].trim();
}

/** Resolve a link target to a vault key: try exact, then name, then basename. */
export function resolveVaultKey(
  target: string,
  keys: string[],
  currentKey?: string
): string | null {
  const clean = normalizeWikilinkTarget(target).replace(/^\.\//, '');
  if (!clean) return null;

  const withExt = /\.(md|markdown|txt)$/i.test(clean) ? clean : `${clean}.md`;
  const candidates = new Set<string>([clean, withExt]);

  for (const candidate of candidates) {
    const exact = keys.find((k) => k === candidate);
    if (exact) return exact;
  }

  // Relative to the current note's folder first.
  if (currentKey) {
    const base = currentKey.includes('/') ? currentKey.slice(0, currentKey.lastIndexOf('/') + 1) : '';
    for (const candidate of candidates) {
      const relative = `${base}${candidate}`;
      const hit = keys.find((k) => k === relative);
      if (hit) return hit;
    }
  }

  // Then anywhere in the vault, matching the file name.
  const wanted = normalizeWikilinkTarget(clean).toLowerCase();
  const wantedWithExt = wanted.endsWith('.md') ? wanted : `${wanted}.md`;
  const byName = keys.filter((k) => {
    const base = k.split('/').pop()?.toLowerCase() || '';
    return base === wanted || base === wantedWithExt || base.replace(/\.md$/, '') === wanted;
  });
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) {
    // Ambiguous: prefer a note next to the current one, else take the shortest path.
    return byName.sort((a, b) => a.length - b.length)[0];
  }

  return null;
}
