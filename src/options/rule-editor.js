import { parseQuerySelectors } from '../shared/query-selectors.js';
import { absoluteWebUrl } from '../shared/rule-transfer.js';

export function getMode(rule) {
  const options = rule.normalizeOptions || {};
  if (options.customFixedUrl) return 'customFixed';
  if (options.keepOriginOnly) return 'keepOriginOnly';
  if (options.keepOriginAndPath) return 'keepOriginAndPath';
  if (options.stripSelectedQueryKeys) return 'stripSelectedQuery';
  if (options.stripAllQueryParams) return 'stripAll';
  if (options.keepSelectedQueryKeys) return 'keepSelectedQuery';
  return '';
}

function invalid(code, field) {
  throw Object.assign(new Error(code), { code, field });
}

// Shared by the editor and its round-trip regressions, including legacy rules.
export function normalizeOptionsFromEditor(mode, fields = {}) {
  if (mode === 'keepOriginOnly') return { keepOriginOnly: true };
  if (mode === 'keepOriginAndPath') return { keepOriginAndPath: true };
  if (mode === 'stripAll') return { stripAllQueryParams: true };
  if (mode === 'stripSelectedQuery') {
    const selectors = parseQuerySelectors(fields.stripQueryKeys || '');
    if (!selectors) invalid('stripKeysInvalid', 'strip-query-keys');
    return { stripSelectedQueryKeys: selectors };
  }
  if (mode === 'keepSelectedQuery') {
    const keys = (fields.keepQueryKeys || '').split(',').map(value => value.trim()).filter(Boolean);
    if (!keys.length) invalid('keysRequired', 'keep-query-keys');
    return { keepSelectedQueryKeys: keys };
  }
  if (mode === 'customFixed') {
    const url = absoluteWebUrl((fields.customFixedUrl || '').trim());
    if (!url) invalid('fixedInvalid', 'custom-fixed-url');
    return { customFixedUrl: url };
  }
  invalid('normalizeModeRequired', 'normalize-mode');
}
