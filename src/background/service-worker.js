import { initHistoryMonitor } from './history-monitor.js';
import { getRules, addTemplateRule, mutateRules } from '../shared/storage.js';
import { getLogs, clearLogs } from '../shared/logger.js';
import { previewExistingHistory, executeExistingHistory, cancelExistingHistory } from './history-processor.js';
import { getExtensionApi } from '../shared/webextension-api.js';

const api = getExtensionApi();
const OPTIONS_ACTIONS = new Set(['manualCleanupPreview', 'manualCleanupExecute', 'manualCleanupCancel', 'addRuleTemplate', 'getRules', 'mutateRules', 'getLogs', 'clearLogs']);

// Initialize the extension
api.runtime.onInstalled.addListener(async details => {
  try {
    await getRules();
    await getLogs(); // Remove URL and path data from logs written by earlier versions.
    if (details.reason === 'install') await api.runtime.openOptionsPage();
  } catch (err) {
    console.error('[HistoryFilter] Could not finish extension initialization');
  }
});

api.action.onClicked.addListener(() => {
  api.runtime.openOptionsPage().catch(() => {
    console.error('[HistoryFilter] Could not open options');
  });
});

// Start the history monitor
initHistoryMonitor();

// Listen for messages from options page
function handleCleanupMessage(request, sender) {
  const optionsUrl = api.runtime.getURL('src/options/options.html');
  if (sender.id !== api.runtime.id || sender.url?.split(/[?#]/)[0] !== optionsUrl) {
    return Promise.resolve({ error: 'This action is only available from the extension options page.', errorCode: 'UNAUTHORIZED' });
  }
  const task = Promise.resolve().then(() => {
    switch (request.action) {
      case 'getRules': return getRules().then(rules => ({ rules }));
      case 'mutateRules': return mutateRules(request);
      case 'getLogs': return getLogs().then(logs => ({ logs }));
      case 'clearLogs': return clearLogs().then(() => ({ cleared: true }));
      case 'manualCleanupPreview': return previewExistingHistory(request.days);
      case 'manualCleanupExecute': return executeExistingHistory(request.planId);
      case 'manualCleanupCancel': return cancelExistingHistory(request.planId);
      case 'addRuleTemplate': return addTemplateRule(request.templateId, { domain: request.domain });
    }
  });
  return task.then(result => result || { cancelled: true })
    .catch(err => {
      if (['RULE_CONFLICT', 'INVALID_RULE', 'RULE_LIMIT'].includes(err.code)) {
        return { error: 'The rule change could not be saved.', errorCode: err.code };
      }
      if (request.action === 'addRuleTemplate') {
        if (err instanceof TypeError) return { error: 'Enter a valid site domain.', errorCode: 'INVALID_TEMPLATE_DOMAIN' };
        if (err instanceof RangeError) return { error: 'Unknown rule template.', errorCode: 'UNKNOWN_TEMPLATE' };
        return { error: 'Could not add the rule template.', errorCode: 'INTERNAL' };
      }
      return {
        error: err.publicMessage ? err.message : 'Manual cleanup failed. Preview again to retry.',
        errorCode: err.publicMessage ? err.code : 'INTERNAL'
      };
    });
}

api.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (!OPTIONS_ACTIONS.has(request?.action)) return false;
  handleCleanupMessage(request, sender).then(sendResponse);
  return true;
});
