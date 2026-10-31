/**
 * Bridge between the new-tab page and the hub state, for backup purposes.
 * The new tab (`extension/newtab.html`) is its own extension page and is the **only**
 * writer of these two keys in `chrome.storage.local`:
 * · changed something; the workbench records it. It never writes back.
 */

import type { HubState, NewtabPreferences } from '../types';

export const NEWTAB_LAYOUT_KEY = 'selfhub_newtab_layout';
export const NEWTAB_PINS_KEY = 'selfhub_newtab_pins';

interface StorageArea {
  get: (keys: string[], cb: (items: Record<string, unknown>) => void) => void;
  set: (items: Record<string, unknown>, cb?: () => void) => void;
}

interface ChromeWithStorage {
  storage?: {
    local?: StorageArea;
    onChanged?: {
      addListener?: (cb: (changes: Record<string, { newValue?: unknown }>, area: string) => void) => void;
      removeListener?: (cb: (changes: Record<string, { newValue?: unknown }>, area: string) => void) => void;
    };
  };
}

function chromeApi(): ChromeWithStorage | null {
  const candidate = (globalThis as unknown as { chrome?: ChromeWithStorage }).chrome;
  const local = candidate?.storage?.local;
  // `typeof` rather than a truthiness check: the declared type says these exist, but at
  // runtime this also runs in a plain web build where `chrome` is a stub with no storage.
  if (typeof local?.get !== 'function' || typeof local?.set !== 'function') return null;
  return candidate ?? null;
}

/** Whether this build can talk to the new tab's storage at all. */
export function canCarryNewtabPreferences(): boolean {
  return chromeApi() !== null;
}

/** Read the new tab's current preferences. `null` when absent or unavailable. */
export async function readNewtabPreferences(): Promise<NewtabPreferences | null> {
  const api = chromeApi();
  const local = api?.storage?.local;
  if (!local?.get) return null;
  const get = local.get.bind(local);
  return new Promise<NewtabPreferences | null>((resolve) => {
    try {
      get([NEWTAB_LAYOUT_KEY, NEWTAB_PINS_KEY], (items) => {
        const layout = items?.[NEWTAB_LAYOUT_KEY];
        const pins = items?.[NEWTAB_PINS_KEY];
        const prefs: NewtabPreferences = {};
        if (layout && typeof layout === 'object' && !Array.isArray(layout)) {
          prefs.layout = layout as Record<string, unknown>;
        }
        if (Array.isArray(pins)) {
          const ids = pins.filter((id): id is string => typeof id === 'string');
          if (ids.length) prefs.pins = ids;
        }
        resolve(prefs.layout || prefs.pins ? prefs : null);
      });
    } catch {
      resolve(null);
    }
  });
}

/**
 * Write preferences back to the new tab (restore path only).
 *
 * Absent fields are left alone rather than cleared: a backup taken before a key existed
 * must not wipe the one the user already has on this machine.
 */
export async function writeNewtabPreferences(prefs: NewtabPreferences | null | undefined): Promise<boolean> {
  const api = chromeApi();
  const local = api?.storage?.local;
  if (!local?.set || !prefs) return false;
  const items: Record<string, unknown> = {};
  if (prefs.layout) items[NEWTAB_LAYOUT_KEY] = prefs.layout;
  if (prefs.pins) items[NEWTAB_PINS_KEY] = prefs.pins;
  if (!Object.keys(items).length) return false;
  const set = local.set.bind(local);
  return new Promise<boolean>((resolve) => {
    try {
      set(items, () => resolve(true));
    } catch {
      resolve(false);
    }
  });
}

/** True when both objects describe the same preferences (used to stop echo loops). */
export function sameNewtabPreferences(
  a: NewtabPreferences | null | undefined,
  b: NewtabPreferences | null | undefined
): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Read the layout straight from `chrome.storage` and graft it onto a state about to be
 * backed up.
 * `App` already mirrors layout changes into the state, so this is belt-and-braces for the
 */
export async function withFreshNewtabPreferences(state: HubState): Promise<HubState> {
  const prefs = await readNewtabPreferences();
  if (!prefs || sameNewtabPreferences(state.newtabPreferences, prefs)) return state;
  return { ...state, newtabPreferences: prefs };
}

/**
 * Subscribe to layout/star changes made by the new tab. Returns an unsubscribe function.
 *
 * The workbench is usually open in another tab while the user drags cards around on the
 * new tab, so this is what keeps `state.newtabPreferences` fresh enough that the next
 * backup carries the layout the user just arranged.
 */
export function onNewtabPreferencesChanged(cb: (prefs: NewtabPreferences) => void): () => void {
  const api = chromeApi();
  const onChanged = api?.storage?.onChanged;
  if (!onChanged?.addListener) return () => {};

  const listener = (changes: Record<string, { newValue?: unknown }>, areaName: string) => {
    if (areaName !== 'local') return;
    if (!(NEWTAB_LAYOUT_KEY in changes) && !(NEWTAB_PINS_KEY in changes)) return;
    void readNewtabPreferences().then((prefs) => {
      if (prefs) cb(prefs);
    });
  };

  onChanged.addListener(listener);
  return () => {
    onChanged.removeListener?.(listener);
  };
}
