/**
 * Pure ordering helpers for the quick-navigation grid (P1-04).
 *
 * Why a separate module: drag-and-drop and the keyboard/button alternative
 * (上移 / 下移 / 移动到…) must produce *identical* results. The only way to
 * guarantee that is to make both call the same pure functions instead of each
 * carrying its own index arithmetic.
 *
 * Contract for `order`:
 * - A site with a numeric `order` sorts before any site without one.
 *   `undefined` means "never reordered" and keeps the array position it already
 *   had, which is exactly the pre-P1-04 behaviour.
 * - Ties (same `order`, or both missing) fall back to `createdAt` and then `id`,
 *   so a render never reshuffles the grid by accident.
 * - Any mutation writes *contiguous* numbers via `renumberCategory`, so one move
 *   cannot leave gaps or duplicate `order` values behind.
 */
import { NavSite } from '../../types';

/** Normalised category key used by the grid ('' and '默认分类' are the same group). */
export function categoryKey(site: NavSite | undefined | null): string {
  return site?.category?.trim() || '默认分类';
}

function byCreatedThenId(a: NavSite, b: NavSite): number {
  const ac = typeof a.createdAt === 'number' ? a.createdAt : 0;
  const bc = typeof b.createdAt === 'number' ? b.createdAt : 0;
  if (ac !== bc) return ac - bc;
  return String(a.id).localeCompare(String(b.id));
}

/**
 * Stable display order. Numbered sites first (ascending), unnumbered sites keep
 * their original relative array order after them.
 */
export function sortSites(sites: NavSite[]): NavSite[] {
  const ranked = sites.map((site, index) => ({ site, index }));
  ranked.sort((a, b) => {
    const ao = a.site.order;
    const bo = b.site.order;
    const aHas = typeof ao === 'number' && Number.isFinite(ao);
    const bHas = typeof bo === 'number' && Number.isFinite(bo);
    if (aHas && bHas) {
      if (ao! !== bo!) return ao! - bo!;
    } else if (aHas !== bHas) {
      return aHas ? -1 : 1;
    }
    const tie = byCreatedThenId(a.site, b.site);
    if (tie !== 0) return tie;
    return a.index - b.index;
  });
  return ranked.map((entry) => entry.site);
}

/**
 * Swap a site with its neighbour inside the same category.
 *
 * Both sites end up with real, contiguous `order` numbers so the move survives a
 * reload. Moves that would leave the category (already first / last) are a no-op
 * that returns the original array unchanged.
 */
export function moveSite(sites: NavSite[], id: string, direction: -1 | 1): NavSite[] {
  const target = sites.find((site) => site.id === id);
  if (!target) return sites;

  const category = categoryKey(target);
  const group = sortSites(sites.filter((site) => categoryKey(site) === category));
  const at = group.findIndex((site) => site.id === id);
  if (at < 0) return sites;

  const swapWith = at + direction;
  if (swapWith < 0 || swapWith >= group.length) return sites;

  const next = group.slice();
  [next[at], next[swapWith]] = [next[swapWith], next[at]];
  return renumberCategory(sites, category, next.map((site) => site.id));
}

/**
 * Move a site to a specific position inside its own category. This is the
 * helper drag-and-drop uses, so a drop and repeated 上移/下移 end up with the
 * same `order` numbers instead of two subtly different reorder algorithms.
 */
export function moveSiteToIndex(sites: NavSite[], id: string, targetIndex: number): NavSite[] {
  const target = sites.find((site) => site.id === id);
  if (!target) return sites;

  const category = categoryKey(target);
  const group = sortSites(sites.filter((site) => categoryKey(site) === category));
  const from = group.findIndex((site) => site.id === id);
  if (from < 0) return sites;

  const to = Math.max(0, Math.min(group.length - 1, targetIndex));
  if (to === from) return sites;

  const next = group.slice();
  const [picked] = next.splice(from, 1);
  next.splice(to, 0, picked);
  return renumberCategory(sites, category, next.map((site) => site.id));
}

/**
 * Drop `id` onto `targetId`: reorder inside the group, or — when the target
 * lives in another group — move into that group (at the target's position).
 */
export function moveSiteOnto(sites: NavSite[], id: string, targetId: string): NavSite[] {
  const source = sites.find((site) => site.id === id);
  const target = sites.find((site) => site.id === targetId);
  if (!source || !target || id === targetId) return sites;

  if (categoryKey(source) !== categoryKey(target)) {
    const moved = moveSiteToCategory(sites, id, categoryKey(target));
    const group = sortSites(moved.filter((site) => categoryKey(site) === categoryKey(target)));
    return moveSiteToIndex(moved, id, group.findIndex((site) => site.id === targetId));
  }

  const group = sortSites(sites.filter((site) => categoryKey(site) === categoryKey(target)));
  return moveSiteToIndex(sites, id, group.findIndex((site) => site.id === targetId));
}

/**
 * Reassign a site to another category and put it at the end of that group.
 * Both the source and the target category are renumbered.
 */
export function moveSiteToCategory(sites: NavSite[], id: string, category: string): NavSite[] {
  const target = sites.find((site) => site.id === id);
  if (!target) return sites;

  const nextCategory = (category || '').trim();
  if (!nextCategory) return sites;

  const from = categoryKey(target);
  if (from === nextCategory) return sites;

  const moved: NavSite[] = sites.map((site) =>
    site.id === id ? { ...site, category: nextCategory } : site
  );
  const others = moved.filter((site) => categoryKey(site) === nextCategory && site.id !== id);
  // Putting the site "at the end" is a sort of its own: give it an `order` past
  // every existing entry of the target group, then let renumberCategory collapse
  // the whole group back to 0..n-1.
  const highest = others.reduce<number>(
    (max, site) => (typeof site.order === 'number' && site.order > max ? site.order : max),
    others.length - 1
  );
  const placed: NavSite[] = moved.map((site) =>
    site.id === id ? { ...site, order: highest + 1 } : site
  );

  let result = renumberCategory(placed, nextCategory);
  result = renumberCategory(result, from);
  return result;
}

/**
 * Write contiguous `order` values (0..n-1) for one category.
 *
 * `orderedIds` lets a caller supply the desired sequence; without it the current
 * `sortSites` order is used. The result is always a new array, and sites in other
 * categories are returned untouched.
 */
export function renumberCategory(sites: NavSite[], category: string, orderedIds?: string[]): NavSite[] {
  const key = (category || '').trim() || '默认分类';
  const group = sortSites(sites.filter((site) => categoryKey(site) === key));

  const sequence = orderedIds ? orderedIds.slice() : group.map((site) => site.id);
  const rank = new Map<string, number>();
  sequence.forEach((id, index) => {
    if (!rank.has(id)) rank.set(id, index);
  });
  // Anything the caller forgot keeps its relative place at the end.
  let cursor = rank.size;
  group.forEach((site) => {
    if (!rank.has(site.id)) rank.set(site.id, cursor++);
  });

  return sites.map((site) =>
    categoryKey(site) === key ? { ...site, order: rank.get(site.id) ?? 0 } : site
  );
}
