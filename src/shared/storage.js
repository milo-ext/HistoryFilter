import { sanitizeImportedRule, mergeImportedRules, MAX_IMPORT_RULES } from './rule-transfer.js';
import { ActionTypes, DEFAULT_RULES, MatchTypes, shortenRuleName } from '../shared/types.js';
import { getExtensionApi } from './webextension-api.js';
import { createTemplateRule, findExistingTemplateRule } from './presets.js';

const STORAGE_KEY = 'history_rules';
const REMOVED_PRESET_IDS = new Set(['preset-long-urls']);
const VALID_ACTIONS = new Set(Object.values(ActionTypes));
const VALID_MATCH_TYPES = new Set(Object.values(MatchTypes));
let rulesQueue = Promise.resolve();

// All production callers live in the single background context.
function enqueue(operation) {
  const task = rulesQueue.then(operation);
  rulesQueue = task.catch(() => {});
  return task;
}

function cloneRules(rules) {
  return JSON.parse(JSON.stringify(rules));
}

function isLegacyLongUrlPreset(rule) {
  return (
    (REMOVED_PRESET_IDS.has(rule.id) || rule.name === 'Block Very Long URLs') &&
    rule.matchType === MatchTypes.REGEX &&
    rule.pattern === '^.{500,}$' &&
    rule.action === ActionTypes.BLOCK
  );
}

function normalizeRule(rule) {
  const normalizedRule = {
    ...rule,
    enabled: rule.enabled !== false
  };

  if (!normalizedRule.name) {
    normalizedRule.name = 'Untitled Rule';
  }
  if (typeof normalizedRule.name === 'string') {
    normalizedRule.name = shortenRuleName(normalizedRule.name);
  }

  if (!normalizedRule.id) {
    normalizedRule.id = `rule_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  if (!VALID_MATCH_TYPES.has(normalizedRule.matchType)) {
    normalizedRule.matchType = MatchTypes.DOMAIN;
  }

  if (normalizedRule.pathPattern && !normalizedRule.pathMatchType) {
    normalizedRule.pathMatchType = 'prefix';
  }

  if (normalizedRule.action === ActionTypes.NORMALIZE && !normalizedRule.normalizeOptions) {
    normalizedRule.normalizeOptions = {};
  }

  return normalizedRule;
}

function migrateRules(rules) {
  if (!Array.isArray(rules)) {
    return cloneRules(DEFAULT_RULES);
  }

  return rules
    .filter(rule => rule && typeof rule === 'object')
    .filter(rule => !isLegacyLongUrlPreset(rule))
    .filter(rule => VALID_ACTIONS.has(rule.action))
    .map(normalizeRule);
}

async function readRules() {
  const result = await getExtensionApi().storage.local.get(STORAGE_KEY);
  if (result[STORAGE_KEY]) {
    const migratedRules = migrateRules(result[STORAGE_KEY]);
    if (JSON.stringify(migratedRules) !== JSON.stringify(result[STORAGE_KEY])) {
      await writeRules(migratedRules);
    }
    return migratedRules;
  }
  const rules = cloneRules(DEFAULT_RULES);
  await writeRules(rules);
  return rules;
}

export function getRules() { return enqueue(readRules); }

async function writeRules(rules) {
  await getExtensionApi().storage.local.set({ [STORAGE_KEY]: cloneRules(rules) });
}

function problem(code) {
  return Object.assign(new Error(code), { code });
}

function validateRule(rule, options) {
  const clean = sanitizeImportedRule(rule, options);
  if (!clean) throw problem('INVALID_RULE');
  return clean;
}

function expectSame(actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw problem('RULE_CONFLICT');
}

export function mutateRules(request) {
  return enqueue(async () => {
    let rules = await readRules();
    let result = {};
    const index = rules.findIndex(rule => rule.id === request.id);
    switch (request.operation) {
      case 'add': {
        const rule = { ...validateRule(request.rule), id: `rule_${crypto.randomUUID()}` };
        rules.push(rule);
        result = { rule };
        break;
      }
      case 'edit': {
        const index = rules.findIndex(rule => rule.id === request.rule?.id);
        if (index < 0) throw problem('RULE_CONFLICT');
        expectSame(rules[index], request.expectedRule);
        rules[index] = validateRule(request.rule);
        break;
      }
      case 'toggle':
        if (index < 0) throw problem('RULE_CONFLICT');
        if (typeof request.enabled !== 'boolean') throw problem('INVALID_RULE');
        // Existing no-mode rules may keep their behavior; new rules and edits
        // must explicitly choose a mode through the strict validation path.
        if (request.enabled) validateRule(rules[index], { allowMissingNormalizeMode: true });
        rules[index] = { ...rules[index], enabled: request.enabled };
        break;
      case 'delete':
        if (index < 0) throw problem('RULE_CONFLICT');
        expectSame(rules[index], request.expectedRule);
        rules.splice(index, 1);
        break;
      case 'move': {
        if (index < 0) throw problem('RULE_CONFLICT');
        if (![1, -1].includes(request.direction)) throw problem('INVALID_RULE');
        const next = index + request.direction;
        if (next >= 0 && next < rules.length) [rules[index], rules[next]] = [rules[next], rules[index]];
        break;
      }
      case 'import': {
        if (!['append', 'replace'].includes(request.mode) || !Array.isArray(request.rules) || !request.rules.length || request.rules.length > MAX_IMPORT_RULES) throw problem('INVALID_RULE');
        if (request.mode === 'replace') expectSame(rules, request.expectedRules);
        const merged = mergeImportedRules(rules, request.rules.map(validateRule), request.mode);
        rules = merged.rules;
        result = { added: merged.added, skipped: merged.skipped };
        break;
      }
      default: throw problem('INVALID_RULE');
    }
    if (rules.length > MAX_IMPORT_RULES) throw problem('RULE_LIMIT');
    await writeRules(rules);
    return result;
  });
}

export function addRule(rule) { return mutateRules({ operation: 'add', rule }).then(result => result.rule); }

export function addTemplateRule(templateId, options = {}) {
  return enqueue(async () => {
    const rules = await readRules();
    const existing = findExistingTemplateRule(rules, templateId, options);
    if (existing) return { rule: existing, added: false };
    if (rules.length >= MAX_IMPORT_RULES) throw problem('RULE_LIMIT');
    const rule = validateRule(createTemplateRule(templateId, options));
    rules.push(rule);
    await writeRules(rules);
    return { rule, added: true };
  });
}
