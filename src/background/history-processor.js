import { getRules } from '../shared/storage.js';
import { evaluateUrl } from './rule-engine.js';
import { ActionTypes } from '../shared/types.js';
import { addLog } from '../shared/logger.js';
import { addNormalizedVisit } from './history-guard.js';
import { getExtensionApi } from '../shared/webextension-api.js';

const MAX_PREVIEW_SAMPLES = 50;
const SEARCH_PAGE_SIZE = 10_000;
const LARGE_HISTORY_THRESHOLD = 10_000;
const MAX_API_RESULTS = 2_147_483_647;
const DAY_MS = 24 * 60 * 60 * 1000;
const PLAN_STORAGE_KEY = 'manual_cleanup_plan';

let busy = false;

function error(message, code) {
  const problem = new Error(message);
  problem.publicMessage = true;
  problem.code = code;
  return problem;
}

function validateDays(days) {
  if (!Number.isInteger(days) || days < 0 || days > 3650) {
    throw error('Choose all history or a whole number of days from 1 to 3650.', 'INVALID_DAYS');
  }
}

function counts(totalChecked) {
  return {
    blockedCount: 0,
    normalizedCount: 0,
    skippedCount: 0,
    invalidTargetCount: 0,
    conflictingTargetCount: 0,
    failedCount: 0,
    partialCount: 0,
    totalChecked
  };
}

async function readPlan() {
  return (await getExtensionApi().storage.session.get(PLAN_STORAGE_KEY))[PLAN_STORAGE_KEY] || null;
}

function sampleFor(operation) {
  const sample = {
    url: operation.url,
    ruleName: operation.ruleName,
    action: operation.action,
    status: operation.status,
    statusCode: operation.status === 'will block' ? 'WILL_BLOCK' :
      operation.status === 'will normalize' ? 'WILL_NORMALIZE' : 'SKIPPED'
  };
  if (operation.newUrl) sample.newUrl = operation.newUrl;
  if (operation.reason) {
    sample.reason = operation.reason;
    sample.reasonCode = 'INVALID_TARGET';
  }
  return sample;
}

async function searchHistoryRange(startTime, endTime) {
  const urls = new Set();
  const windows = [[startTime, endTime]];
  while (windows.length) {
    const [start, end] = windows.pop();
    const items = await getExtensionApi().history.search({
      text: '', startTime: start, endTime: end, maxResults: SEARCH_PAGE_SIZE
    });
    if (items.length < SEARCH_PAGE_SIZE) {
      for (const item of items) if (item.url) urls.add(item.url);
      continue;
    }

    if (end - start <= 2) {
      // No offset exists in history.search. Ask for a larger complete result
      // at this timestamp instead of silently accepting the first page.
      let requested = SEARCH_PAGE_SIZE * 2;
      let expanded = await getExtensionApi().history.search({ text: '', startTime: start, endTime: end, maxResults: requested });
      if (expanded.length < items.length) {
        throw error('The browser could not enumerate all URLs at the same visit time. No cleanup was performed.', 'SCAN_INCOMPLETE');
      }
      while (expanded.length >= requested) {
        if (requested >= MAX_API_RESULTS) {
          throw error('The browser could not enumerate all URLs at the same visit time. No cleanup was performed.', 'SCAN_INCOMPLETE');
        }
        const previousLength = expanded.length;
        requested = Math.min(requested * 2, MAX_API_RESULTS);
        expanded = await getExtensionApi().history.search({ text: '', startTime: start, endTime: end, maxResults: requested });
        if (expanded.length < previousLength) {
          throw error('The browser could not enumerate all URLs at the same visit time. No cleanup was performed.', 'SCAN_INCOMPLETE');
        }
      }
      for (const item of expanded) if (item.url) urls.add(item.url);
      continue;
    }

    const midpoint = start + Math.floor((end - start) / 2);
    // One millisecond overlap covers either inclusive or exclusive boundary
    // handling in Chrome; the Set removes duplicate URLs.
    windows.push([start, midpoint + 1], [midpoint, end]);
  }
  return urls;
}

// Session storage survives normal service worker suspension, but is cleared on
// extension reload or browser restart. It is inaccessible to content scripts.
export async function previewExistingHistory(days) {
  validateDays(days);
  if (busy) throw error('A cleanup scan or execution is already running. Try again shortly.', 'BUSY');
  busy = true;
  try {
    await getExtensionApi().storage.session.remove(PLAN_STORAGE_KEY);
    const endTime = Date.now();
    const startTime = days === 0 ? 1 : endTime - days * DAY_MS;
    const rules = await getRules();
    const rulesSnapshot = JSON.stringify(rules);
    const historyUrls = await searchHistoryRange(startTime, endTime);
    const result = { ...counts(historyUrls.size), samples: [] };
    const operations = [];
    for (const url of historyUrls) {
      const evaluation = evaluateUrl(url, rules);
      if (!evaluation) continue;

      let operation;
      if (evaluation.action === ActionTypes.BLOCK) {
        operation = { url, ruleName: evaluation.ruleName, action: ActionTypes.BLOCK, status: 'will block' };
        result.blockedCount++;
      } else if (evaluation.action === ActionTypes.NORMALIZE) {
        if (!evaluation.normalizedUrl) {
          operation = { url, ruleName: evaluation.ruleName, action: ActionTypes.NORMALIZE,
            status: 'skipped', reason: 'The configured normalized URL is invalid.' };
          result.skippedCount++;
          result.invalidTargetCount++;
        } else if (evaluation.normalizedUrl !== url) {
          operation = { url, newUrl: evaluation.normalizedUrl, ruleName: evaluation.ruleName,
            action: ActionTypes.NORMALIZE, status: 'will normalize' };
          result.normalizedCount++;
        }
      }
      if (!operation) continue;
      if (result.samples.length < MAX_PREVIEW_SAMPLES) result.samples.push(sampleFor(operation));
      if (operation.status !== 'skipped') operations.push(operation);
    }

    // A normalization target may itself be a source selected for deletion or
    // normalization. Skip that write so execution order cannot change its fate.
    const sourceUrls = new Set(operations.map(operation => operation.url));
    const safeOperations = operations.filter(operation => {
      if (operation.action !== ActionTypes.NORMALIZE || !sourceUrls.has(operation.newUrl)) return true;
      result.normalizedCount--;
      result.skippedCount++;
      result.conflictingTargetCount++;
      const sample = result.samples.find(item => item.url === operation.url);
      if (sample) {
        sample.status = 'skipped';
        sample.statusCode = 'SKIPPED';
        sample.reason = 'The target URL is also scheduled for cleanup.';
        sample.reasonCode = 'CONFLICTING_TARGET';
      }
      return false;
    });
    const planId = crypto.randomUUID();
    const planOperations = safeOperations.map(operation => operation.action === ActionTypes.BLOCK
      ? [operation.url] : [operation.url, operation.newUrl]);
    const plan = { planId, rulesSnapshot,
      operations: planOperations,
      totalChecked: historyUrls.size,
      skippedCount: result.skippedCount, invalidTargetCount: result.invalidTargetCount,
      conflictingTargetCount: result.conflictingTargetCount };
    try {
      await getExtensionApi().storage.session.set({ [PLAN_STORAGE_KEY]: plan });
    } catch (err) {
      if (/quota|max.*bytes|exceeds.*bytes/i.test(String(err?.message))) {
        throw error('The frozen preview exceeds browser temporary storage capacity. No cleanup was performed.', 'PLAN_SIZE');
      }
      throw err;
    }
    return { ...result, planId, startTime, endTime,
      largeHistory: historyUrls.size > LARGE_HISTORY_THRESHOLD,
      warningThreshold: LARGE_HISTORY_THRESHOLD };
  } finally {
    busy = false;
  }
}

export async function executeExistingHistory(planId) {
  if (busy) throw error('A cleanup scan or execution is already running. Try again shortly.', 'BUSY');
  busy = true;
  try {
    const plan = await readPlan();
    if (!plan || typeof planId !== 'string' || planId !== plan.planId) {
      throw error('This preview is no longer available. Preview again before executing.', 'PLAN_UNAVAILABLE');
    }
    // Claim before any history mutation; a restarted worker cannot replay it.
    await getExtensionApi().storage.session.remove(PLAN_STORAGE_KEY);
    if (JSON.stringify(await getRules()) !== plan.rulesSnapshot) {
      throw error('Rules changed since this preview. Preview again before executing.', 'RULES_CHANGED');
    }
    const result = counts(plan.totalChecked);
    result.skippedCount = plan.skippedCount;
    result.invalidTargetCount = plan.invalidTargetCount;
    result.conflictingTargetCount = plan.conflictingTargetCount;

    for (const [url, newUrl] of plan.operations) {
      if (newUrl === undefined) {
        try {
          await getExtensionApi().history.deleteUrl({ url });
          result.blockedCount++;
        } catch (err) {
          console.error('[HistoryFilter] Manual cleanup failed to delete a matched URL');
          result.failedCount++;
        }
      } else {
        try {
          await addNormalizedVisit(newUrl);
        } catch (err) {
          console.error('[HistoryFilter] Manual cleanup failed to add a target URL');
          result.failedCount++;
          continue;
        }
        try {
          await getExtensionApi().history.deleteUrl({ url });
          result.normalizedCount++;
        } catch (err) {
          console.error('[HistoryFilter] Manual cleanup added a target but failed to delete its original URL');
          result.partialCount++;
        }
      }
    }

    try {
      await addLog({ action: 'cleanup', code: 'completed', counts: result });
    } catch (err) {
      // A logging failure must not hide completed, irreversible history changes.
      console.error('[HistoryFilter] Manual cleanup could not save its activity log');
    }
    return result;
  } finally {
    busy = false;
  }
}

export async function cancelExistingHistory(planId) {
  if (busy) return;
  const plan = await readPlan();
  if (plan && plan.planId === planId) await getExtensionApi().storage.session.remove(PLAN_STORAGE_KEY);
}
