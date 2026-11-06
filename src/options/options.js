import { compileSafeRegex } from '../shared/safe-regex.js';
import { ActionTypes, MatchTypes } from '../shared/types.js';
import { BUILTIN_TEMPLATES } from '../shared/presets.js';
import { parseQuerySelectors } from '../shared/query-selectors.js';
import { createRulesExport, MAX_IMPORT_BYTES, normalizeDomainPattern, parseRulesImport } from '../shared/rule-transfer.js';
import { evaluateUrl } from '../background/rule-engine.js';
import { getExtensionApi, sendExtensionMessage } from '../shared/webextension-api.js';
import { message } from './locales.js';
import { getMode, normalizeOptionsFromEditor } from './rule-editor.js';

const $ = id => document.getElementById(id);
const ICONS = {
  up: 'm6 14 6-6 6 6',
  down: 'm6 10 6 6 6-6',
  edit: 'm4 20 4-.9L19 8a2 2 0 0 0-3-3L5 16l-1 4Z',
  trash: 'M4 7h16M7 7V5h10v2m-11 0 1 13h10l1-13M10 11v6m4-6v6'
};
const ERROR_KEYS = {
  INVALID_DAYS: 'cleanupDaysInvalid', BUSY: 'cleanupBusy', SCAN_INCOMPLETE: 'cleanupScanIncomplete',
  PLAN_SIZE: 'cleanupPlanSize',
  PLAN_UNAVAILABLE: 'cleanupUnavailable', RULES_CHANGED: 'cleanupRulesChanged',
  UNAUTHORIZED: 'cleanupUnauthorized'
};
const LOG_ACTIONS = { block:'logBlock', normalize:'logNormalize', cleanup:'logCleanup', skip:'logSkip', error:'logError' };
const LOG_CODES = { completed:'logCompleted', invalid_target:'logInvalidTarget', delete_failed:'logDeleteFailed', add_failed:'logAddFailed', delete_after_add_failed:'logPartial', legacy:'logLegacy' };
const TEMPLATE_KEYS = {
  'google-translate':'Google', 'utm-cleanup':'Utm', 'tco-block':'Tco',
  'site-domain-block':'Site', 'local-dev-block':'Local'
};
const IMPORT_ERROR_KEYS = {
  INVALID_JSON:'importInvalidJson', INVALID_FORMAT:'importInvalidFormat', UNSUPPORTED_VERSION:'importUnsupportedVersion',
  TOO_MANY:'importTooMany', NO_VALID_RULES:'importNoValidRules'
};
let locale = 'en';
let rules = [];
let logs = [];
let page = 'rules';
let editingId = null;
let editingSnapshot = null;
let deletingSnapshot = null;
let deletingId = null;
let previousFocus = null;
let preview = null;
let result = null;
let cleanupBusy = false;
let lastTestUrl = '';
let cleanupStatusState = null;
let ruleStatusKey = null;
let ruleStatusVars = {};
let pendingImport = null;
let importErrorKey = null;
let formErrorKey = null;
let pendingTemplateId = null;
let templateBusy = false;
let templateErrorKey = null;
let templateStatusKey = null;

const getRules = () => sendCleanupMessage({ action: 'getRules' }).then(result => result.rules);
const getLogs = () => sendCleanupMessage({ action: 'getLogs' }).then(result => result.logs);
const mutateRules = request => sendCleanupMessage({ action: 'mutateRules', ...request });
const ruleErrorKey = error => ({ RULE_CONFLICT: 'ruleConflict', INVALID_RULE: 'ruleInvalid', RULE_LIMIT: 'ruleLimit' }[error?.errorCode] || 'ruleError');

const t = (key, vars) => message(locale, key, vars);
const num = value => new Intl.NumberFormat(locale).format(Number(value) || 0);
const dateTime = value => new Intl.DateTimeFormat(locale, { dateStyle:'medium', timeStyle:'short' }).format(new Date(value));
function element(tag, className, value) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (value !== undefined) node.textContent = value;
  return node;
}
function setStatus(key, kind = 'note', vars = {}) {
  cleanupStatusState = key ? {key,kind,vars} : null;
  const node = $('cleanup-status');
  node.textContent = key ? t(key, vars) : '';
  node.className = key ? `status-${kind}` : '';
}
function staticCopy() {
  document.documentElement.lang = locale;
  document.title = `HistoryFilter — ${t({rules:'navRules',cleanup:'navCleanup',activity:'navActivity'}[page])}`;
  document.querySelectorAll('[data-i18n]').forEach(node => { node.textContent = t(node.dataset.i18n); });
  document.querySelectorAll('[data-i18n-placeholder]').forEach(node => { node.placeholder = t(node.dataset.i18nPlaceholder); });
  document.querySelectorAll('[data-i18n-aria-label]').forEach(node => { node.setAttribute('aria-label', t(node.dataset.i18nAriaLabel)); });
  $('language-toggle').textContent = t('switchLanguage');
  $('language-toggle').setAttribute('aria-label', t('switchLanguageLabel'));
  $('crumb').textContent = t('breadcrumb', { page: t({rules:'navRules',cleanup:'navCleanup',activity:'navActivity'}[page]) });
  $('modal-title').textContent = t(pendingTemplateId ? 'siteTemplateTitle' : editingId ? 'editRuleTitle' : 'addRuleTitle');
  $('save-rule-btn').textContent = t(pendingTemplateId ? 'templateAddEnable' : 'saveRule');
  editorConditionalCopy();
  if (cleanupStatusState) setStatus(cleanupStatusState.key,cleanupStatusState.kind,cleanupStatusState.vars);
  if (ruleStatusKey) $('rule-status').textContent = t(ruleStatusKey, ruleStatusVars);
  renderTemplates();renderImport();
}
async function initializeLocale() {
  try {
    const saved = (await getExtensionApi().storage.local.get('options_locale')).options_locale;
    locale = saved === 'zh-CN' || saved === 'en' ? saved : (/^zh\b/i.test(navigator.language) ? 'zh-CN' : 'en');
  } catch {
    locale = /^zh\b/i.test(navigator.language) ? 'zh-CN' : 'en';
  }
  staticCopy();
}
async function switchLanguage() {
  locale = locale === 'en' ? 'zh-CN' : 'en';
  try { await getExtensionApi().storage.local.set({ options_locale: locale }); } catch { /* The current page still switches. */ }
  staticCopy();
  renderRules(); renderLogs(); renderCleanup();
  if (lastTestUrl) runTest(); else $('test-result').textContent = t('testIdle');
  if (formErrorKey) $('form-error').textContent = t(formErrorKey);
}
function setPage(next) {
  page = next;
  document.querySelectorAll('.page').forEach(node => node.classList.toggle('active', node.id === `page-${next}`));
  document.querySelectorAll('.nav button').forEach(node => {
    const active = node.dataset.page === next;
    node.classList.toggle('active', active);
    if (active) node.setAttribute('aria-current', 'page'); else node.removeAttribute('aria-current');
  });
  $('crumb').textContent = t('breadcrumb', { page:t({rules:'navRules',cleanup:'navCleanup',activity:'navActivity'}[next]) });
  document.title = `HistoryFilter — ${t({rules:'navRules',cleanup:'navCleanup',activity:'navActivity'}[next])}`;
  $(`${next}-title`).focus();
  window.scrollTo({ top:0, behavior:'instant' });
}
function iconButton(icon, className, label, id, disabled) {
  const node = element('button', `btn icon ${className}`);
  node.type = 'button'; node.dataset.id = id;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', ICONS[icon]);svg.append(path);node.append(svg);
  node.disabled = disabled; node.title = label; node.setAttribute('aria-label', label);
  return node;
}
function renderRules() {
  const list = $('rules-list'); list.replaceChildren();
  $('default-preset-note').hidden = !rules.some(rule => rule.id === 'preset-google-translate' &&
    rule.matchType === MatchTypes.DOMAIN && rule.pattern === 'translate.google.com' &&
    !rule.pathPattern && rule.queryKey === 'text' && rule.action === ActionTypes.NORMALIZE &&
    rule.normalizeOptions?.keepOriginOnly);
  $('rule-count').textContent = t('ruleCount', { count:num(rules.length) });
  if (!rules.length) { list.append(element('div','empty',t('emptyRules'))); return; }
  rules.forEach((rule,index) => {
    const active = rule.enabled !== false;
    const row = element('div',`rule rule-card${active?'':' is-off'}`);
    row.append(element('div','order',String(index+1).padStart(2,'0')));
    const main = element('div','rule-main'); const title = element('div','rule-title');
    title.append(element('strong','',rule.name),element('span',`pill ${rule.action === ActionTypes.BLOCK ? 'red':'blue'}`,t(rule.action === ActionTypes.BLOCK?'actionBlock':'actionNormalize')));
    if (rule.matchType === MatchTypes.REGEX && !compileSafeRegex(rule.pattern)) {
      main.append(element('p','status-error',t('regexUnsupported')));
    }
    const meta = element('div','rule-meta');
    meta.append(element('span','',t(rule.matchType === MatchTypes.REGEX?'typeRegex':rule.matchType === MatchTypes.QUERY?'typeQuery':'typeDomain')),element('code','',rule.pattern));
    if (rule.matchType === MatchTypes.DOMAIN) {
      if (rule.pathPattern) meta.append(element('span','',t(rule.pathMatchType === 'exact'?'pathEquals':'pathStarts',{path:rule.pathPattern})));
      if (rule.queryKey) meta.append(element('span','',t('queryKey',{key:rule.queryKey})));
    }
    if (rule.action === ActionTypes.NORMALIZE) meta.append(element('span','',t(getMode(rule) || 'normalizeModeMissing')));
    main.append(title,meta);row.append(main);
    const actions = element('div','rule-actions');
    const toggle = element('label','switch'); const check = document.createElement('input');
    check.type = 'checkbox';check.className = 'rule-enabled';check.checked = active;check.dataset.id = rule.id;
    check.setAttribute('aria-label',t(active?'disableNamed':'enableNamed',{name:rule.name}));
    const track = element('span');track.setAttribute('aria-hidden','true');
    toggle.append(check,track,document.createTextNode(t(active?'enabled':'disabled')));
    actions.append(toggle,
      iconButton('up','move-up',t('moveUp',{name:rule.name}),rule.id,index===0),
      iconButton('down','move-down',t('moveDown',{name:rule.name}),rule.id,index===rules.length-1),
      iconButton('edit','edit',t('editNamed',{name:rule.name}),rule.id,false),
      iconButton('trash','delete',t('deleteNamed',{name:rule.name}),rule.id,false));
    row.append(actions);list.append(row);
  });
}
async function reloadRules() { rules = await getRules(); renderRules(); renderTemplates(); }
function hasFixedTemplate(id) {
  return rules.some(rule => rule.templateId === id ||
    (id === 'google-translate' && rule.id === 'preset-google-translate'));
}
function renderTemplates() {
  const list = $('template-list');list.replaceChildren();
  for (const template of BUILTIN_TEMPLATES) {
    const suffix = TEMPLATE_KEYS[template.id];
    if (!suffix) continue;
    const item = element('div','template-item');item.dataset.templateId = template.id;
    const copy = element('div');
    copy.append(element('h3','',t(`template${suffix}Title`)),
      element('p','',t(`template${suffix}Effect`)));
    const example = element('div','template-example');
    example.append(element('div','',`${t('templateBefore')}: ${t(`template${suffix}Before`)}`),
      element('div','',`${t('templateAfter')}: ${t(`template${suffix}After`)}`));
    copy.append(example);
    const added = !template.requiresDomain && hasFixedTemplate(template.id);
    const button = element('button',added?'btn':'btn primary',t(added?'templateAdded':template.requiresDomain?'templateConfigure':'templateAddEnable'));
    button.type = 'button';button.dataset.templateId = template.id;
    button.disabled = added || templateBusy;
    item.append(copy,button);list.append(item);
  }
  $('template-error').textContent = templateErrorKey ? t(templateErrorKey) : '';
  $('template-status').textContent = templateStatusKey ? t(templateStatusKey) : '';
}
async function openTemplates() {
  try { await reloadRules(); } catch { /* Keep the current list if storage is temporarily unavailable. */ }
  templateErrorKey = null;templateStatusKey = null;renderTemplates();
  const first = $('template-list').querySelector('button:not(:disabled)') || $('close-templates-btn');
  openDialog($('template-modal'),first);
}
async function addFixedTemplate(templateId) {
  const template = BUILTIN_TEMPLATES.find(item => item.id === templateId);
  if (!template || template.requiresDomain || templateBusy || hasFixedTemplate(templateId)) return;
  templateBusy = true;templateErrorKey = null;templateStatusKey = null;renderTemplates();
  try {
    const response = await sendCleanupMessage({action:'addRuleTemplate',templateId});
    if (response.added) {
      await invalidatePreview();await reloadRules();
      if (lastTestUrl) runTest();
      ruleStatusKey = 'templateAddedStatus';
      $('rule-status').className = 'status-good';$('rule-status').textContent = t(ruleStatusKey);
    } else await reloadRules();
    templateStatusKey = response.added ? 'templateAddedStatus' : 'templateAlreadyStatus';
  } catch (error) {
    templateErrorKey = error?.errorCode === 'UNKNOWN_TEMPLATE' ? 'templateUnknownError' : 'templateAddError';
  } finally {
    templateBusy = false;renderTemplates();$('close-templates-btn').focus();
  }
}
async function changeRules(operation) {
  try {
    await operation(); await invalidatePreview(); await reloadRules();
    ruleStatusKey = null;$('rule-status').textContent = '';
    if (lastTestUrl) runTest();
  } catch (error) {
    setRuleStatus(ruleErrorKey(error),'error');
    try { await reloadRules(); } catch { /* Keep the save error visible if the background is unavailable. */ }
  }
}
async function moveRule(id, direction) {
  await changeRules(() => mutateRules({ operation: 'move', id, direction }));
}
async function toggleRule(id, enabled) {
  await changeRules(() => mutateRules({ operation: 'toggle', id, enabled }));
}
function openDialog(back, focusTarget) {
  previousFocus = document.activeElement; back.hidden = false; document.body.style.overflow = 'hidden';
  requestAnimationFrame(() => focusTarget.focus());
}
function closeDialog(back) {
  back.hidden = true;document.body.style.overflow = '';
  if (back === $('rule-modal')) { pendingTemplateId = null;editingId = null; }
  if (back === $('import-modal')) pendingImport = null;
  if (previousFocus?.isConnected) previousFocus.focus(); else $('add-rule-btn').focus();
}
function editorConditionalCopy() {
  const type = $('rule-match-type').value;
  const action = $('rule-action').value;
  const mode = $('normalize-mode').value;
  const site = pendingTemplateId === 'site-domain-block';
  $('site-template-note').hidden = !site;
  $('rule-name').closest('.field').hidden = site;
  $('rule-action').closest('.field').hidden = site;
  $('rule-match-type').closest('.field').hidden = site;
  $('rule-form').querySelector('.advance').hidden = site;
  $('pattern-label').textContent = t(site?'siteTemplateDomainLabel':type === MatchTypes.REGEX?'regexLabel':type === MatchTypes.QUERY?'querySelectorLabel':'domainLabel');
  $('pattern-help').textContent = t(site?'siteTemplateDomainHelp':type === MatchTypes.REGEX?'regexHelp':type === MatchTypes.QUERY?'querySelectorHelp':'domainHelp');
  $('rule-pattern').placeholder = site ? 'example.com' : type === MatchTypes.REGEX ? '^https://example\\.com/' : type === MatchTypes.QUERY ? 'utm_*' : 'example.com';
  $('action-help').textContent = t(action === ActionTypes.BLOCK?'blockHelp':'normalizeHelp');
  $('normalize-help').textContent = t({keepOriginOnly:'modeOriginHelp',keepOriginAndPath:'modePathHelp',stripAll:'modeStripHelp',stripSelectedQuery:'modeStripSelectedHelp',keepSelectedQuery:'modeKeysHelp',customFixed:'modeFixedHelp'}[mode] || 'normalizeModeMissingHelp');
  $('domain-matching-options').hidden = site || type !== MatchTypes.DOMAIN;
  $('normalize-options').hidden = site || action === ActionTypes.BLOCK;
  $('strip-query-container').hidden = site || action === ActionTypes.BLOCK || mode !== 'stripSelectedQuery';
  $('selected-query-container').hidden = site || action === ActionTypes.BLOCK || mode !== 'keepSelectedQuery';
  $('custom-fixed-container').hidden = site || action === ActionTypes.BLOCK || mode !== 'customFixed';
}
function openEditor(id = null, templateId = null) {
  const rule = id ? rules.find(item => item.id === id) : null;
  editingId = rule?.id || null;
  editingSnapshot = rule ? structuredClone(rule) : null;
  pendingTemplateId = templateId;
  $('rule-form').reset();$('rule-id').value = editingId || '';
  $('rule-name').value = rule?.name || '';
  $('rule-enabled').checked = rule?.enabled !== false;
  $('rule-match-type').value = rule?.matchType || MatchTypes.DOMAIN;
  $('rule-pattern').value = rule?.pattern || '';
  $('rule-path-pattern').value = rule?.pathPattern || '';
  $('rule-path-match-type').value = rule?.pathMatchType || 'prefix';
  $('rule-query-key').value = rule?.queryKey || '';
  $('rule-action').value = rule?.action || (templateId === 'site-domain-block' ? ActionTypes.BLOCK : ActionTypes.NORMALIZE);
  $('normalize-mode').value = rule ? getMode(rule) : 'keepOriginOnly';
  $('strip-query-keys').value = (rule?.normalizeOptions?.stripSelectedQueryKeys || []).join(', ');
  $('keep-query-keys').value = (rule?.normalizeOptions?.keepSelectedQueryKeys || []).join(', ');
  $('custom-fixed-url').value = rule?.normalizeOptions?.customFixedUrl || '';
  formErrorKey = null;$('form-error').textContent = '';
  $('modal-title').textContent = t(templateId ? 'siteTemplateTitle' : rule ? 'editRuleTitle' : 'addRuleTitle');
  $('save-rule-btn').textContent = t(templateId ? 'templateAddEnable' : 'saveRule');
  editorConditionalCopy();openDialog($('rule-modal'),$('rule-name'));
}
function templateDomain(value) {
  const input = value.trim();if (!input) return null;
  try {
    const url = new URL(/^[a-z][\w+.-]*:\/\//i.test(input) ? input : `https://${input}`);
    if (!['http:','https:'].includes(url.protocol) || url.username || url.password ||
        url.port || url.pathname !== '/' || url.search || url.hash) return null;
    const hostname = url.hostname.replace(/\.$/,'').toLowerCase();
    if (hostname === 'localhost') return hostname;
    return hostname.split('.').every(label => label.length > 0 && label.length <= 63 &&
      /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)) ? hostname : null;
  } catch { return null; }
}
function formError(key, id) {
  formErrorKey = key;
  $('form-error').textContent = t(key);$(id)?.focus();return null;
}
function formRule() {
  const name = $('rule-name').value.trim();if (!name) return formError('nameRequired','rule-name');
  const matchType = $('rule-match-type').value;
  const raw = $('rule-pattern').value.trim();if (!raw) return formError('patternRequired','rule-pattern');
  let pattern = raw;
  if (matchType === MatchTypes.DOMAIN) { pattern = normalizeDomainPattern(raw);if (!pattern) return formError('domainInvalid','rule-pattern'); }
  else if (matchType === MatchTypes.QUERY) {
    const selectors = parseQuerySelectors(raw);
    if (!selectors) return formError('querySelectorsInvalid','rule-pattern');
    pattern = selectors.join(', ');
  }
  else if (!compileSafeRegex(raw)) return formError('regexInvalid','rule-pattern');
  const action = $('rule-action').value;
  const pathPattern = matchType === MatchTypes.DOMAIN ? $('rule-path-pattern').value.trim() : '';
  if (pathPattern && !pathPattern.startsWith('/')) return formError('pathInvalid','rule-path-pattern');
  const data = {name,enabled:$('rule-enabled').checked,matchType,pattern,pathPattern,
    pathMatchType:$('rule-path-match-type').value,
    queryKey:matchType === MatchTypes.DOMAIN ? $('rule-query-key').value.trim() : '',
    action,normalizeOptions:{}};
  if (action === ActionTypes.NORMALIZE) {
    try {
      data.normalizeOptions = normalizeOptionsFromEditor($('normalize-mode').value, {
        stripQueryKeys: $('strip-query-keys').value,
        keepQueryKeys: $('keep-query-keys').value,
        customFixedUrl: $('custom-fixed-url').value
      });
    } catch (error) { return formError(error.code, error.field); }
  }
  if (editingId) {
    data.id = editingId;
    const original = editingSnapshot;
    if (original?.templateId) data.templateId = original.templateId;
  }
  return data;
}
async function saveEditor(event) {
  if (pendingTemplateId === 'site-domain-block') return saveSiteTemplate(event);
  event.preventDefault();const data = formRule();if (!data) return;
  const save = $('save-rule-btn');save.disabled = true;
  try {
    await mutateRules({ operation: editingId ? 'edit' : 'add', rule: data, expectedRule: editingSnapshot });
    await invalidatePreview();await reloadRules();formErrorKey = null;closeDialog($('rule-modal'));
    if (lastTestUrl) runTest();
  } catch (error) { formErrorKey = ruleErrorKey(error);$('form-error').textContent = t(formErrorKey); }
  finally { save.disabled = false; }
}
async function saveSiteTemplate(event) {
  event.preventDefault();
  const domain = templateDomain($('rule-pattern').value);
  if (!domain) return formError('siteTemplateDomainInvalid','rule-pattern');
  const save = $('save-rule-btn');save.disabled = true;
  try {
    const response = await sendCleanupMessage({action:'addRuleTemplate',templateId:'site-domain-block',domain});
    if (!response.added) {
      formError('siteTemplateAlready','rule-pattern');
      await reloadRules();return;
    }
    await invalidatePreview();await reloadRules();formErrorKey = null;closeDialog($('rule-modal'));
    ruleStatusKey = 'templateAddedStatus';
    $('rule-status').className = 'status-good';$('rule-status').textContent = t(ruleStatusKey);
    if (lastTestUrl) runTest();
  } catch (error) {
    formError(error?.errorCode === 'INVALID_TEMPLATE_DOMAIN' ? 'siteTemplateDomainInvalid' :
      error?.errorCode === 'UNKNOWN_TEMPLATE' ? 'templateUnknownError' : 'templateAddError','rule-pattern');
  } finally { save.disabled = false; }
}
function setRuleStatus(key, kind, vars = {}) {
  ruleStatusKey = key;ruleStatusVars = vars;
  $('rule-status').className = `status-${kind}`;$('rule-status').textContent = t(key, vars);
}
function localDateStamp(date) {
  return [date.getFullYear(),date.getMonth()+1,date.getDate()].map(part => String(part).padStart(2,'0')).join('-');
}
async function exportRules() {
  try {
    const now = new Date();
    const data = createRulesExport(await getRules(), now);
    const link = element('a');
    link.href = URL.createObjectURL(new Blob([`${JSON.stringify(data,null,2)}\n`],{type:'application/json'}));
    link.download = `historyfilter-rules-${localDateStamp(now)}.json`;
    document.body.append(link);link.click();link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    setRuleStatus('exportDone','good',{count:num(data.rules.length)});
  } catch (error) { setRuleStatus(error?.code === 'INVALID_EXPORT_RULE' ? 'exportInvalidRule' : 'exportError','error'); }
}
async function readImportFile(event) {
  const input = event.target;const file = input.files?.[0];input.value = '';
  if (!file) return;
  if (file.size > MAX_IMPORT_BYTES) { setRuleStatus('importFileTooLarge','error');return; }
  let text;
  try { text = await file.text(); } catch { setRuleStatus('importReadError','error');return; }
  try {
    const parsed = parseRulesImport(text);
    pendingImport = { ...parsed, fileName: file.name, expectedRules: await getRules() };
  } catch (error) {
    setRuleStatus(IMPORT_ERROR_KEYS[error?.code] || 'importReadError','error');return;
  }
  ruleStatusKey = null;$('rule-status').textContent = '';
  importErrorKey = null;
  document.querySelector('input[name="import-mode"][value="append"]').checked = true;
  renderImport();openDialog($('import-modal'),$('import-confirm-btn'));
}
function renderImport() {
  if (!pendingImport) return;
  $('import-summary').textContent = t('importSummary',{valid:num(pendingImport.rules.length),file:pendingImport.fileName});
  $('import-invalid').hidden = !pendingImport.invalidCount;
  $('import-invalid').textContent = t('importInvalidNote',{count:num(pendingImport.invalidCount)});
  $('import-replace-help').textContent = t('importReplaceHelp',{count:num(rules.length)});
  const replace = document.querySelector('input[name="import-mode"]:checked')?.value === 'replace';
  $('import-confirm-btn').className = `btn ${replace ? 'danger' : 'primary'}`;
  $('import-error').textContent = importErrorKey ? t(importErrorKey) : '';
}
async function confirmImport() {
  if (!pendingImport) return;
  const mode = document.querySelector('input[name="import-mode"]:checked')?.value === 'replace' ? 'replace' : 'append';
  const button = $('import-confirm-btn');button.disabled = true;
  try {
    const merged = await mutateRules({ operation: 'import', mode, rules: pendingImport.rules, expectedRules: pendingImport.expectedRules });
    await invalidatePreview();await reloadRules();
    if (lastTestUrl) runTest();
    pendingImport = null;closeDialog($('import-modal'));
    setRuleStatus(merged.skipped ? 'importDoneWithSkipped' : 'importDone','good',{added:num(merged.added),skipped:num(merged.skipped)});
  } catch (error) {
    importErrorKey = ruleErrorKey(error);renderImport();
  } finally { button.disabled = false; }
}
function openDelete(id) { deletingId = id;deletingSnapshot = structuredClone(rules.find(rule => rule.id === id));openDialog($('delete-modal'),$('delete-cancel-btn')); }
async function confirmDelete() {
  if (!deletingId) return;const id = deletingId;deletingId = null;
  await changeRules(() => mutateRules({ operation: 'delete', id, expectedRule: deletingSnapshot }));closeDialog($('delete-modal'));
}
function runTest() {
  const value = $('test-url').value.trim();lastTestUrl = value;
  const output = $('test-result');if (!value) { output.textContent = t('testInvalid');return; }
  let url;try { url = new URL(value);if (!['http:','https:'].includes(url.protocol)) throw Error(); } catch { output.textContent = t('testInvalid');return; }
  const result = evaluateUrl(url.href,rules);
  if (!result) output.textContent = t('testNone');
  else if (result.action === ActionTypes.BLOCK) output.textContent = t('testBlock',{name:result.ruleName});
  else if (!result.normalizedUrl) output.textContent = t('testInvalidTarget',{name:result.ruleName});
  else if (result.normalizedUrl === url.href) output.textContent = t('testUnchanged',{name:result.ruleName});
  else output.textContent = t('testNormalize',{name:result.ruleName,url:result.normalizedUrl});
}
function sendCleanupMessage(messageBody) {
  return sendExtensionMessage(messageBody).then(response => {
    if (!response) throw {errorCode:'INTERNAL'};
    if (response.error) throw response;
    return response;
  }).catch(error => {
    if (error?.errorCode) throw error;
    throw {errorCode:'INTERNAL'};
  });
}
async function invalidatePreview() {
  const planId = preview?.planId;preview = null;
  if (planId) { try { await sendCleanupMessage({action:'manualCleanupCancel',planId}); } catch { /* A missing plan needs no further action. */ } }
  renderCleanup();
}
function stat(label, value) {
  const node = element('div','stat');node.append(element('strong','stat-value',num(value)),element('span','',t(label)));return node;
}
function renderSamples(samples) {
  const container = element('div','sample');
  container.append(element('div','sample-head',t('sampleTitle',{count:num(samples.length)})));
  if (!samples.length) { container.append(element('div','empty',t('noSamples')));return container; }
  samples.forEach(sample => {
    const row = element('div','sample-row');
    const statusKey = sample.statusCode === 'WILL_BLOCK'?'sampleWillBlock':sample.statusCode === 'WILL_NORMALIZE'?'sampleWillNormalize':'sampleSkipped';
    const pill = element('span',`pill ${statusKey === 'sampleWillBlock'?'red':statusKey === 'sampleWillNormalize'?'blue':'gray'}`,t(statusKey));
    const urls = element('div','urls');
    urls.append(element('code','',`${t('sampleBefore')}: ${sample.url || ''}`));
    if (sample.newUrl) urls.append(element('code','after',`${t('sampleAfter')}: ${sample.newUrl}`));
    const rule = element('small','',`${t('sampleRule')}: ${sample.ruleName || '—'}`);
    urls.append(rule);
    if (sample.statusCode === 'SKIPPED') {
      const reasonKey = sample.reasonCode === 'INVALID_TARGET'?'sampleInvalidTarget':sample.reasonCode === 'CONFLICTING_TARGET'?'sampleConflictingTarget':'sampleUnknownReason';
      urls.append(element('small','',`${t('sampleReason')}: ${t(reasonKey)}`));
    }
    row.append(pill,urls);container.append(row);
  });return container;
}
function renderCleanup() {
  const current = preview || result;
  $('preview-container').hidden = !current;
  $('confirm-cleanup-btn').disabled = !preview || cleanupBusy;
  $('preview-actions').hidden = !preview;
  if (!current) return;
  const isPreview = Boolean(preview);
  $('preview-title').textContent = t(isPreview?'previewTitle':'resultTitle');
  $('preview-subtitle').textContent = t(isPreview?'previewSubtitle':'resultSubtitle');
  const body = $('preview-stats');body.replaceChildren();
  const stats = element('div','stats');
  stats.append(stat('scanCount',current.totalChecked),stat(isPreview?'willBlock':'didBlock',current.blockedCount),stat(isPreview?'willNormalize':'didNormalize',current.normalizedCount),stat('skipped',current.skippedCount));
  body.append(stats);
  if (current.failedCount || current.partialCount) {
    const extras = element('div','stats');extras.append(stat('failed',current.failedCount),stat('partial',current.partialCount));body.append(extras);
  }
  const additional = [];
  if (current.invalidTargetCount) additional.push(`${t('invalidTargets')}: ${num(current.invalidTargetCount)}`);
  if (current.conflictingTargetCount) additional.push(`${t('conflictingTargets')}: ${num(current.conflictingTargetCount)}`);
  if (additional.length) body.append(element('p','helper',additional.join(' · ')));
  if (isPreview) {
    const metadata = element('div','preview-meta');
    const start = current.startTime === 1 ? t('rangeAll') : dateTime(current.startTime);
    metadata.append(element('div','',t('rangeText',{start,end:dateTime(current.endTime)})));
    body.append(metadata);
    if (current.largeHistory) {
      const warning = element('div','hintbar');
      const content = element('div');
      content.append(element('strong','',t('largeHistoryTitle')),document.createTextNode(' '),
        element('span','',t('largeHistoryBody',{
          count:num(current.totalChecked),threshold:num(current.warningThreshold)
        })));
      warning.append(content);body.append(warning);
    }
    const alert = element('div','alert');alert.append(element('strong','',t('riskTitle')));
    const list = element('ul');['riskDelete','riskNormalize','riskResult'].forEach(key => list.append(element('li','',t(key))));alert.append(list);body.append(alert);
    body.append(element('p','helper',t('sampleNote')),renderSamples(current.samples || []));
  }
}
function syncRangeControls() {
  const recent = $('cleanup-recent').checked;
  $('cleanup-recent').disabled = cleanupBusy;
  $('cleanup-all-time').disabled = cleanupBusy;
  $('cleanup-days').disabled = cleanupBusy || !recent;
  $('cleanup-btn').disabled = cleanupBusy;
  document.querySelectorAll('.range-choice').forEach(choice => {
    choice.classList.toggle('selected',choice.querySelector('input[type="radio"]').checked);
  });
}
function onRangeEdited() {
  syncRangeControls();
  const hadPreview = Boolean(preview);
  result = null;
  void invalidatePreview();
  setStatus(hadPreview ? 'rangeChanged' : null);
}
async function previewCleanup() {
  if (cleanupBusy) return;
  const recent = $('cleanup-recent').checked;
  const days = recent ? Number($('cleanup-days').value) : 0;
  if (recent && (!Number.isInteger(days) || days < 1 || days > 3650)) { setStatus('cleanupDaysInvalid','error');return; }
  cleanupBusy = true;syncRangeControls();
  await invalidatePreview();result = null;renderCleanup();
  setStatus('cleanupScanning');
  try {
    const response = await sendCleanupMessage({action:'manualCleanupPreview',days});
    preview = response;renderCleanup();setStatus(null);
  } catch (error) { setStatus(ERROR_KEYS[error?.errorCode] || 'cleanupPreviewError','error'); }
  finally { cleanupBusy = false;syncRangeControls();renderCleanup(); }
}
async function executeCleanup() {
  if (!preview || cleanupBusy) return;
  const planId = preview.planId;preview = null;renderCleanup();
  cleanupBusy = true;syncRangeControls();$('confirm-cleanup-btn').disabled = true;setStatus('cleanupExecuting');
  try {
    result = await sendCleanupMessage({action:'manualCleanupExecute',planId});
    renderCleanup();setStatus(result.failedCount || result.partialCount?'resultProblems':result.blockedCount || result.normalizedCount?'resultComplete':'resultNoActions',result.failedCount || result.partialCount?'error':'good');
    await reloadLogs();
  } catch (error) { result = null;renderCleanup();setStatus(ERROR_KEYS[error?.errorCode] || 'cleanupExecuteError','error'); }
  finally { cleanupBusy = false;syncRangeControls(); }
}
async function reloadLogs() { try { logs = await getLogs();renderLogs(); } catch { $('logs-list').replaceChildren(element('div','empty',t('logsError'))); } }
function renderLogs() {
  const list = $('logs-list');list.replaceChildren();
  if (!logs.length) { list.append(element('div','empty',t('emptyLogs')));return; }
  logs.forEach(log => {
    const row = element('div','log-row');
    let displayTime = '—';try { displayTime = dateTime(log.timestamp); } catch { /* Legacy timestamps may be malformed. */ }
    row.append(element('span','log-time',displayTime));
    const body = element('div','log-main');body.append(element('strong','',t(LOG_ACTIONS[log.action] || 'logError')));
    const parts = [t(LOG_CODES[log.code] || 'logLegacy')];
    if (log.counts) parts.push(t('logCounts',{blocked:num(log.counts.blockedCount),normalized:num(log.counts.normalizedCount),skipped:num(log.counts.skippedCount),failed:num(log.counts.failedCount),partial:num(log.counts.partialCount)}));
    body.append(element('span','',parts.join(' · ')));row.append(body);list.append(row);
  });
}
async function clearActivity() { try { await sendCleanupMessage({ action: 'clearLogs' });await reloadLogs(); } catch { $('logs-list').replaceChildren(element('div','empty',t('logsClearError'))); } }
function trapDialog(event) {
  const back = [...document.querySelectorAll('.modal-back')].find(node => !node.hidden);if (!back) return;
  if (event.key === 'Escape') { closeDialog(back);return; }
  if (event.key !== 'Tab') return;
  const items = [...back.querySelectorAll('button,input,select,summary')].filter(node => !node.disabled && node.getClientRects().length);
  const first = items[0],last = items.at(-1);
  if (event.shiftKey && document.activeElement === first) {event.preventDefault();last.focus();}
  else if (!event.shiftKey && document.activeElement === last) {event.preventDefault();first.focus();}
}
function attachEvents() {
  $('language-toggle').addEventListener('click',switchLanguage);
  document.querySelectorAll('.nav button').forEach(node => node.addEventListener('click',()=>setPage(node.dataset.page)));
  $('add-rule-btn').addEventListener('click',()=>openEditor());
  $('open-templates-btn').addEventListener('click',openTemplates);
  $('template-list').addEventListener('click',event => {
    const button = event.target.closest('button[data-template-id]');
    if (!button || button.disabled) return;
    const templateId = button.dataset.templateId;
    if (templateId === 'site-domain-block') {
      closeDialog($('template-modal'));
      openEditor(null,templateId);
    } else void addFixedTemplate(templateId);
  });
  $('close-templates-btn').addEventListener('click',()=>closeDialog($('template-modal')));
  $('cancel-templates-btn').addEventListener('click',()=>closeDialog($('template-modal')));
  $('rules-list').addEventListener('click',event => {
    const button = event.target.closest('button[data-id]');if (!button) return;
    const id = button.dataset.id;
    if (button.classList.contains('move-up')) moveRule(id,-1);
    else if (button.classList.contains('move-down')) moveRule(id,1);
    else if (button.classList.contains('edit')) openEditor(id);
    else if (button.classList.contains('delete')) openDelete(id);
  });
  $('rules-list').addEventListener('change',event => { if (event.target.classList.contains('rule-enabled')) toggleRule(event.target.dataset.id,event.target.checked); });
  $('export-rules-btn').addEventListener('click',exportRules);
  $('import-rules-btn').addEventListener('click',()=>$('import-file').click());
  $('import-file').addEventListener('change',readImportFile);
  document.querySelectorAll('input[name="import-mode"]').forEach(node => node.addEventListener('change',renderImport));
  $('import-confirm-btn').addEventListener('click',confirmImport);
  $('import-cancel-btn').addEventListener('click',()=>closeDialog($('import-modal')));
  $('close-import-btn').addEventListener('click',()=>closeDialog($('import-modal')));
  $('test-rule-btn').addEventListener('click',runTest);
  $('test-url').addEventListener('keydown',event => { if (event.key === 'Enter') runTest(); });
  ['rule-action','rule-match-type','normalize-mode'].forEach(id => $(id).addEventListener('change',editorConditionalCopy));
  $('rule-form').addEventListener('submit',saveEditor);
  $('cancel-btn').addEventListener('click',()=>closeDialog($('rule-modal')));
  $('close-rule-btn').addEventListener('click',()=>closeDialog($('rule-modal')));
  $('delete-cancel-btn').addEventListener('click',()=>closeDialog($('delete-modal')));
  $('delete-confirm-btn').addEventListener('click',confirmDelete);
  $('cleanup-recent').addEventListener('change',onRangeEdited);
  $('cleanup-all-time').addEventListener('change',onRangeEdited);
  $('cleanup-days').addEventListener('input',onRangeEdited);
  $('cleanup-btn').addEventListener('click',previewCleanup);
  $('confirm-cleanup-btn').addEventListener('click',executeCleanup);
  $('cancel-cleanup-btn').addEventListener('click',async()=> { await invalidatePreview();setStatus(null);$('cleanup-btn').focus(); });
  $('clear-logs-btn').addEventListener('click',clearActivity);
  document.querySelectorAll('.modal-back').forEach(back => back.addEventListener('mousedown',event => { if (event.target === back) closeDialog(back); }));
  document.addEventListener('keydown',trapDialog);
}
async function initialize() {
  getExtensionApi().storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.history_rules) {
      void (async () => {
        await invalidatePreview();await reloadRules();
        if (lastTestUrl) runTest();
      })().catch(() => setRuleStatus('ruleError','error'));
    }
    if (changes.history_logs) void reloadLogs();
  });
  attachEvents();await initializeLocale();syncRangeControls();$('test-result').textContent = t('testIdle');
  try {await reloadRules();} catch { $('rules-list').append(element('div','empty',t('ruleError'))); }
  await reloadLogs();renderCleanup();
}
initialize();
