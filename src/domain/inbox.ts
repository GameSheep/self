/**
 * Inbox capture rules (P1-03).
 * "Record something" is the first path a new user takes, so it must never
 * require a type, a project, or a configured cloud service. This module owns the
 */
import type { InboxItem } from '../types';

const URL_LIKE = /^(https?:\/\/|www\.)\S+$/i;

export function newOperationId(prefix = 'cap'): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${rand}`;
}

/** Domain-ish check that does not need a network round trip. */
export function looksLikeUrl(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || /\s/.test(trimmed)) return false;
  return URL_LIKE.test(trimmed);
}

export function normalizeCapturedUrl(text: string): string {
  const trimmed = text.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

/**
 * Build an inbox entry from raw input.
 *
 * A URL-only capture keeps the URL in `url` and stores the URL as the title so
 * the list row is readable without fetching the page (fetching is a separate,
 * user-initiated action).
 */
export function makeInboxEntry(
  rawText: string,
  options: { source?: InboxItem['source']; operationId?: string } = {}
): InboxItem {
  const text = rawText.trim();
  const isUrl = looksLikeUrl(text);
  return {
    id: `inbox-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    content: text,
    url: isUrl ? normalizeCapturedUrl(text) : undefined,
    title: isUrl ? text.slice(0, 80) : undefined,
    type: isUrl ? 'url' : 'text',
    status: 'inbox',
    createdAt: Date.now(),
    operationId: options.operationId ?? newOperationId(),
    source: options.source ?? 'home'
  };
}

/** Existing entry for this operation id, if the submission was already stored. */
export function findByOperationId(inbox: InboxItem[] | undefined, operationId: string): InboxItem | undefined {
  if (!operationId) return undefined;
  return (inbox || []).find((item) => item.operationId === operationId);
}

/**
 * Insert unless the operation id is already present. Returns the entry that is
 * now authoritative plus whether this call actually created it.
 */
export function captureIntoInbox(
  inbox: InboxItem[] | undefined,
  rawText: string,
  options: { source?: InboxItem['source']; operationId?: string } = {}
): { items: InboxItem[]; entry: InboxItem; created: boolean } {
  const operationId = options.operationId ?? newOperationId();
  const existing = findByOperationId(inbox, operationId);
  if (existing) return { items: inbox || [], entry: existing, created: false };
  const entry = makeInboxEntry(rawText, { ...options, operationId });
  return { items: [entry, ...(inbox || [])], entry, created: true };
}

/**
 * Merge captures that came from the extension into the local inbox.
 * Idempotent by `operationId`: the extension's inbox is append-only from the
 * app's point of view, and the new-tab quick note stays in chrome.storage until it
 * · is acknowledged, so the same text can be observed more than once. Only
 */
export function mergeExtensionCaptures(
  inbox: InboxItem[] | undefined,
  captures: Array<{ operationId: string; text: string; url?: string; createdAt: number }>
): { items: InboxItem[]; imported: number; quickNoteImported: boolean } {
  let items = [...(inbox || [])];
  const known = new Set(items.map((i) => i.operationId).filter(Boolean) as string[]);
  let imported = 0;
  let quickNoteImported = false;

  for (const capture of captures) {
    if (!capture.text.trim() || known.has(capture.operationId)) continue;
    const isUrl = looksLikeUrl(capture.text);
    const entry: InboxItem = {
      id: `inbox-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      content: capture.text,
      url: capture.url || (isUrl ? normalizeCapturedUrl(capture.text) : undefined),
      title: isUrl ? capture.text.slice(0, 80) : undefined,
      type: isUrl ? 'url' : 'text',
      status: 'inbox',
      createdAt: capture.createdAt || Date.now(),
      operationId: capture.operationId,
      source: 'extension'
    };
    items = [entry, ...items];
    known.add(capture.operationId);
    imported += 1;
    if (capture.operationId.startsWith('ext-quicknote-')) quickNoteImported = true;
  }

  return { items, imported, quickNoteImported };
}
