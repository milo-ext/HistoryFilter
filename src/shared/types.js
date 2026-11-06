export const ActionTypes = {
  BLOCK: 'block',
  NORMALIZE: 'normalize'
};

export const MatchTypes = {
  DOMAIN: 'domain',
  QUERY: 'query',
  REGEX: 'regex'
};

export const MAX_RULE_NAME_LENGTH = 100;

// Only shorten display names; matching conditions must remain untouched.
export function shortenRuleName(name) {
  if (name.length <= MAX_RULE_NAME_LENGTH) return name;
  return name.slice(0, MAX_RULE_NAME_LENGTH - 1).replace(/[\uD800-\uDBFF]$/, '') + '…';
}

export const DEFAULT_RULES = [
  {
    id: 'preset-google-translate',
    name: 'Google Translate Cleanup',
    matchType: MatchTypes.DOMAIN,
    pattern: 'translate.google.com',
    queryKey: 'text',
    action: ActionTypes.NORMALIZE,
    enabled: false,
    normalizeOptions: {
      keepOriginOnly: true
    }
  }
];
