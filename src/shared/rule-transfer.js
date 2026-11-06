import { compileSafeRegex } from './safe-regex.js';
import { ActionTypes, MatchTypes, MAX_RULE_NAME_LENGTH, shortenRuleName } from './types.js';
import { BUILTIN_TEMPLATES } from './presets.js';
import { parseQuerySelectors } from './query-selectors.js';

export const EXPORT_FORMAT = 'historyfilter-rules';
export const EXPORT_VERSION = 1;
export const MAX_IMPORT_BYTES = 1024 * 1024;
export const MAX_IMPORT_RULES = 500;
const MAX_TEXT_LENGTH = 2048;
const TEMPLATE_IDS = new Set(BUILTIN_TEMPLATES.map(template => template.id));
const VALID_ACTIONS = new Set(Object.values(ActionTypes));
const VALID_MATCH_TYPES = new Set(Object.values(MatchTypes));

export class RuleImportError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

export function normalizeDomainPattern(value) {
  const text = String(value).trim().toLowerCase();if (!text) return null;
  let host;
  try {
    const parsed = new URL(/^[a-z][\w+.-]*:\/\//i.test(text)?text:`https://${text}`);
    host = parsed.hostname.replace(/^\.+|\.+$/g,'').toLowerCase();
  } catch { return null; }
  if (host === 'localhost') return host;
  return host.split('.').every(label => label.length > 0 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)) ? host : null;
}

export function absoluteWebUrl(value) {
  try { const url = new URL(value);return ['http:','https:'].includes(url.protocol)?url.href:null; } catch { return null; }
}

function shortText(value) {
  return typeof value === 'string' && value.trim().length <= MAX_TEXT_LENGTH ? value.trim() : null;
}

function sanitizeNormalizeOptions(options, allowMissingMode = false) {
  if (options === undefined) return allowMissingMode ? {} : null;
  if (!options || typeof options !== 'object' || Array.isArray(options)) return null;
  const result = {};
  if (options.keepOriginOnly === true) result.keepOriginOnly = true;
  if (options.keepOriginAndPath === true) result.keepOriginAndPath = true;
  if (options.stripAllQueryParams === true) result.stripAllQueryParams = true;
  if (options.stripSelectedQueryKeys !== undefined) {
    const selectors = parseQuerySelectors(options.stripSelectedQueryKeys);
    if (!selectors || !Array.isArray(options.stripSelectedQueryKeys)) return null;
    result.stripSelectedQueryKeys = selectors;
  }
  if (options.keepSelectedQueryKeys !== undefined) {
    const keys = Array.isArray(options.keepSelectedQueryKeys) ? options.keepSelectedQueryKeys.map(shortText) : [];
    if (!keys.length || keys.some(key => !key)) return null;
    result.keepSelectedQueryKeys = [...new Set(keys)];
  }
  if (options.customFixedUrl !== undefined) {
    const url = typeof options.customFixedUrl === 'string' ? absoluteWebUrl(options.customFixedUrl.trim()) : null;
    if (!url) return null;
    result.customFixedUrl = url;
  }
  // The editor stores one mode per rule; a file mixing modes is ambiguous.
  const modeCount = Object.keys(result).length;
  return modeCount === 1 || (allowMissingMode && modeCount === 0) ? result : null;
}

// Rebuild a rule from known fields only, applying the same checks as the editor.
export function sanitizeImportedRule(raw, {
  allowUnsupportedRegex = false, allowMissingNormalizeMode = false, shortenLegacyName = false
} = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  let name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (shortenLegacyName) name = shortenRuleName(name);
  if (!name || name.length > MAX_RULE_NAME_LENGTH) return null;
  if (!VALID_ACTIONS.has(raw.action) || !VALID_MATCH_TYPES.has(raw.matchType)) return null;
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') return null;
  const source = shortText(raw.pattern);if (!source) return null;
  let pattern = source;
  if (raw.matchType === MatchTypes.DOMAIN) pattern = normalizeDomainPattern(source);
  else if (raw.matchType === MatchTypes.QUERY) pattern = parseQuerySelectors(source)?.join(', ');
  else if (!allowUnsupportedRegex && !compileSafeRegex(source)) return null;
  if (!pattern) return null;
  const rule = { name, enabled: raw.enabled !== false, matchType: raw.matchType, pattern, action: raw.action };
  if (raw.matchType === MatchTypes.DOMAIN) {
    const pathPattern = raw.pathPattern === undefined ? '' : shortText(raw.pathPattern);
    const queryKey = raw.queryKey === undefined ? '' : shortText(raw.queryKey);
    const pathMatchType = raw.pathMatchType === undefined ? 'prefix' : raw.pathMatchType;
    if (pathPattern === null || queryKey === null || !['prefix','exact'].includes(pathMatchType)) return null;
    if (pathPattern && !pathPattern.startsWith('/')) return null;
    if (pathPattern) Object.assign(rule, { pathPattern, pathMatchType });
    if (queryKey) rule.queryKey = queryKey;
  }
  if (raw.action === ActionTypes.NORMALIZE) {
    const normalizeOptions = sanitizeNormalizeOptions(raw.normalizeOptions, allowMissingNormalizeMode);
    if (!normalizeOptions) return null;
    rule.normalizeOptions = normalizeOptions;
  }
  if (typeof raw.id === 'string' && /^[\w-]{1,100}$/.test(raw.id)) rule.id = raw.id;
  if (TEMPLATE_IDS.has(raw.templateId)) rule.templateId = raw.templateId;
  return rule;
}

export function createRulesExport(rules, now = new Date()) {
  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: now.toISOString(),
    // Backups retain known legacy behavior even when new imports require the
    // user to repair it. Never produce a successful but incomplete backup.
    rules: rules.map(rule => {
      const clean = sanitizeImportedRule(rule, {
        allowUnsupportedRegex: true, allowMissingNormalizeMode: true, shortenLegacyName: true
      });
      if (!clean) throw new RuleImportError('INVALID_EXPORT_RULE');
      return clean;
    })
  };
}

// Accepts a HistoryFilter export or a bare array of rules.
export function parseRulesImport(text) {
  let data;
  try { data = JSON.parse(text); } catch { throw new RuleImportError('INVALID_JSON'); }
  let entries = data;
  if (!Array.isArray(data)) {
    if (!data || typeof data !== 'object' || data.format !== EXPORT_FORMAT || !Array.isArray(data.rules)) {
      throw new RuleImportError('INVALID_FORMAT');
    }
    if (!Number.isInteger(data.version) || data.version < 1) throw new RuleImportError('INVALID_FORMAT');
    if (data.version > EXPORT_VERSION) throw new RuleImportError('UNSUPPORTED_VERSION');
    entries = data.rules;
  }
  if (entries.length > MAX_IMPORT_RULES) throw new RuleImportError('TOO_MANY');
  const rules = entries.map(sanitizeImportedRule).filter(Boolean);
  if (!rules.length) throw new RuleImportError('NO_VALID_RULES');
  return { rules, invalidCount: entries.length - rules.length };
}

function ruleFingerprint(rule) {
  // Sanitized rules are rebuilt in a fixed key order, so stringify is stable.
  const clean = sanitizeImportedRule(rule) || rule;
  const { name, enabled, id, templateId, ...definition } = clean;
  return JSON.stringify(definition);
}

function uniqueIds(rules, taken) {
  return rules.map(rule => {
    const id = rule.id && !taken.has(rule.id) ? rule.id : `rule_${crypto.randomUUID()}`;
    taken.add(id);
    return { ...rule, id };
  });
}

// append keeps current rules first and skips imported rules with an identical
// definition; replace uses the file's rules and order.
export function mergeImportedRules(current, imported, mode) {
  if (mode === 'replace') {
    return { rules: uniqueIds(imported, new Set()), added: imported.length, skipped: 0 };
  }
  const seen = new Set(current.map(ruleFingerprint));
  const additions = imported.filter(rule => {
    const fingerprint = ruleFingerprint(rule);
    if (seen.has(fingerprint)) return false;
    seen.add(fingerprint);
    return true;
  });
  const taken = new Set(current.map(rule => rule.id));
  return {
    rules: [...current, ...uniqueIds(additions, taken)],
    added: additions.length,
    skipped: imported.length - additions.length
  };
}
