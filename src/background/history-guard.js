import { getExtensionApi } from '../shared/webextension-api.js';

// One expected event per addUrl, not a time window that suppresses real visits.
// Tokens are separate so concurrent writes of the same target consume one each.
const pending = new Map();
const EXPIRY_MS = 5000;

function remove(url, token) {
  clearTimeout(token.timer);
  const tokens = pending.get(url);
  if (!tokens) return;
  tokens.delete(token);
  if (!tokens.size) pending.delete(url);
}

export async function addNormalizedVisit(url) {
  const token = {};
  if (!pending.has(url)) pending.set(url, new Set());
  pending.get(url).add(token);
  token.timer = setTimeout(() => remove(url, token), EXPIRY_MS);
  // Node test processes need not wait for unused synthetic-event tokens.
  token.timer.unref?.();
  try {
    await getExtensionApi().history.addUrl({ url });
  } catch (error) {
    remove(url, token);
    throw error;
  }
}

export function shouldIgnoreUrl(url) {
  const token = pending.get(url)?.values().next().value;
  if (!token) return false;
  remove(url, token);
  return true;
}
