import { ActionTypes, DEFAULT_RULES, MatchTypes, shortenRuleName } from './types.js';

const LOCAL_DEV_PATTERN = '^https?://(?:localhost|127\\.0\\.0\\.1)(?::\\d+)?(?:[/?#]|$)';

export const BUILTIN_TEMPLATES = [
  {
    id: 'google-translate',
    name: 'Google Translate Cleanup',
    rule: DEFAULT_RULES[0]
  },
  {
    id: 'utm-cleanup',
    name: 'Remove UTM Parameters',
    rule: {
      matchType: MatchTypes.QUERY,
      pattern: 'utm_*',
      action: ActionTypes.NORMALIZE,
      normalizeOptions: { stripSelectedQueryKeys: ['utm_*'] }
    }
  },
  {
    id: 'tco-block',
    name: 'Block t.co History',
    rule: {
      matchType: MatchTypes.DOMAIN,
      pattern: 't.co',
      action: ActionTypes.BLOCK
    }
  },
  {
    id: 'site-domain-block',
    name: 'Block a Site Domain',
    requiresDomain: true,
    rule: {
      matchType: MatchTypes.DOMAIN,
      action: ActionTypes.BLOCK
    }
  },
  {
    id: 'local-dev-block',
    name: 'Block Local Development History',
    rule: {
      matchType: MatchTypes.REGEX,
      pattern: LOCAL_DEV_PATTERN,
      action: ActionTypes.BLOCK
    }
  }
];

function normalizeTemplateDomain(input) {
  if (typeof input !== 'string' || !input.trim()) throw new TypeError('Enter a site domain.');
  const value = input.trim();
  let url;
  try {
    url = new URL(/^[a-z][\w+.-]*:\/\//i.test(value) ? value : `https://${value}`);
  } catch {
    throw new TypeError('Enter a valid site domain.');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port ||
      url.pathname !== '/' || url.search || url.hash) {
    throw new TypeError('Enter a domain only, without a path, port, or query.');
  }
  const hostname = url.hostname.replace(/\.$/, '').toLowerCase();
  if (hostname !== 'localhost' && !hostname.split('.').every(label =>
    label.length > 0 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) {
    throw new TypeError('Enter a valid site domain.');
  }
  return hostname;
}

export function createTemplateRule(templateId, { domain } = {}) {
  const template = BUILTIN_TEMPLATES.find(item => item.id === templateId);
  if (!template) throw new RangeError('Unknown rule template.');
  const rule = JSON.parse(JSON.stringify(template.rule));
  if (template.requiresDomain) {
    rule.pattern = normalizeTemplateDomain(domain);
    rule.name = shortenRuleName(`Block ${rule.pattern} History`);
  } else {
    rule.name = template.name;
  }
  return {
    ...rule,
    id: `rule_${crypto.randomUUID()}`,
    templateId,
    enabled: true
  };
}

export function findExistingTemplateRule(rules, templateId, { domain } = {}) {
  const template = BUILTIN_TEMPLATES.find(item => item.id === templateId);
  if (!template) throw new RangeError('Unknown rule template.');
  const normalizedDomain = template.requiresDomain ? normalizeTemplateDomain(domain) : null;
  return rules.find(rule =>
    (rule.templateId === templateId && (!normalizedDomain || rule.pattern === normalizedDomain)) ||
    (templateId === 'google-translate' && rule.id === 'preset-google-translate')
  ) || null;
}
