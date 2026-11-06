import { getExtensionApi } from './webextension-api.js';

let logQueue = Promise.resolve();
function enqueue(operation) {
  const task = logQueue.then(operation);
  logQueue = task.catch(() => {});
  return task;
}

const LOGS_KEY = 'history_logs';
const MAX_LOGS = 100;
const ACTIONS = new Set(['block', 'normalize', 'cleanup', 'skip', 'error']);
const CODES = new Set([
  'completed', 'invalid_target', 'delete_failed', 'add_failed',
  'delete_after_add_failed', 'legacy'
]);
const COUNT_FIELDS = [
  'blockedCount', 'normalizedCount', 'skippedCount', 'invalidTargetCount',
  'conflictingTargetCount', 'failedCount', 'partialCount'
];

// Kept for callers that need a safe diagnostic marker, never an origin or path.
export function sanitizeUrlForLog() {
  return '[URL redacted]';
}

function safeLog(entry) {
  if (!entry || typeof entry !== 'object' || !ACTIONS.has(entry.action)) return null;
  const log = {
    timestamp: Number.isFinite(entry.timestamp) && entry.timestamp > 0 ? entry.timestamp : Date.now(),
    action: entry.action,
    code: CODES.has(entry.code) ? entry.code : 'legacy'
  };
  if (log.action === 'cleanup' && entry.counts && typeof entry.counts === 'object') {
    const counts = {};
    for (const key of COUNT_FIELDS) {
      if (Number.isSafeInteger(entry.counts[key]) && entry.counts[key] >= 0) counts[key] = entry.counts[key];
    }
    log.counts = counts;
  }
  return log;
}

async function readMigratedLogs() {
  const result = await getExtensionApi().storage.local.get(LOGS_KEY);
  const original = Array.isArray(result[LOGS_KEY]) ? result[LOGS_KEY] : [];
  const logs = original.map(safeLog).filter(Boolean).slice(0, MAX_LOGS);
  if (JSON.stringify(logs) !== JSON.stringify(original)) {
    await getExtensionApi().storage.local.set({ [LOGS_KEY]: logs });
  }
  return logs;
}

export function addLog(entry) {
  return enqueue(async () => {
    const log = safeLog({ ...entry, timestamp: Date.now() });
    if (!log) return;
    const logs = await readMigratedLogs();
    logs.unshift(log);
    await getExtensionApi().storage.local.set({ [LOGS_KEY]: logs.slice(0, MAX_LOGS) });
  });
}

export async function getLogs() {
  return enqueue(readMigratedLogs);
}

export async function clearLogs() {
  return enqueue(() => getExtensionApi().storage.local.set({ [LOGS_KEY]: [] }));
}
