import { getRules } from '../shared/storage.js';
import { evaluateUrl } from './rule-engine.js';
import { ActionTypes } from '../shared/types.js';
import { addLog } from '../shared/logger.js';
import { addNormalizedVisit, shouldIgnoreUrl } from './history-guard.js';
import { getExtensionApi } from '../shared/webextension-api.js';

async function addSkippedLog() {
  console.warn('[HistoryFilter] Skipped normalization because the target URL is invalid');
  await addLog({ action: 'skip', code: 'invalid_target' });
}

async function handleBlock(historyItem) {
  console.log('[HistoryFilter] Blocking matched URL');

  try {
    await getExtensionApi().history.deleteUrl({ url: historyItem.url });
    await addLog({ action: 'block', code: 'completed' });
  } catch (err) {
    console.error('[HistoryFilter] Failed to block matched URL');
    await addLog({ action: 'error', code: 'delete_failed' });
  }
}

async function handleNormalize(historyItem, normalizedUrl) {
  if (!normalizedUrl) {
    await addSkippedLog();
    return;
  }

  if (normalizedUrl === historyItem.url) {
    return;
  }

  console.log('[HistoryFilter] Normalizing matched URL');


  let normalizedAdded = false;

  try {
    await addNormalizedVisit(normalizedUrl);
    normalizedAdded = true;
    await getExtensionApi().history.deleteUrl({ url: historyItem.url });
    await addLog({ action: 'normalize', code: 'completed' });
  } catch (err) {
    console.error('[HistoryFilter] Failed to normalize matched URL');
    await addLog({
      action: 'error',
      code: normalizedAdded ? 'delete_after_add_failed' : 'add_failed'
    });
  }
}

export async function onHistoryVisited(historyItem) {
  if (shouldIgnoreUrl(historyItem.url)) {
    return;
  }

  const rules = await getRules();
  const evaluation = evaluateUrl(historyItem.url, rules);

  if (!evaluation) return;

  if (evaluation.action === ActionTypes.BLOCK) {
    await handleBlock(historyItem);
  } else if (evaluation.action === ActionTypes.NORMALIZE) {
    await handleNormalize(historyItem, evaluation.normalizedUrl);
  }
}

export function initHistoryMonitor() {
  getExtensionApi().history.onVisited.addListener(onHistoryVisited);
  console.log('[HistoryFilter] History monitor initialized');
}
