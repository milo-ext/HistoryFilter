import { compileSafeRegex } from '../shared/safe-regex.js';
import { ActionTypes, MatchTypes } from '../shared/types.js';
import { normalizeUrl } from './normalizer.js';
import { hasSelectedQueryKey } from '../shared/query-selectors.js';

export function evaluateUrl(urlStr, rules) {
  for (const rule of rules) {
    // Skip disabled rules (default to true if missing)
    if (rule.enabled === false) {
      continue;
    }

    let matches = false;

    try {
      if (rule.matchType === MatchTypes.DOMAIN) {
        const urlObj = new URL(urlStr);
        let currentMatches = urlObj.hostname === rule.pattern || urlObj.hostname.endsWith('.' + rule.pattern);

        // Check Path (if domain matched and path pattern specified)
        if (currentMatches && rule.pathPattern) {
          const path = urlObj.pathname;
          if (rule.pathMatchType === 'exact') {
            currentMatches = path === rule.pathPattern;
          } else if (rule.pathMatchType === 'prefix') {
            currentMatches = path.startsWith(rule.pathPattern);
          }
        }

        // Check Query Key (if still matching and query key specified)
        if (currentMatches && rule.queryKey) {
          const params = new URLSearchParams(urlObj.search);
          currentMatches = params.has(rule.queryKey);
        }

        matches = currentMatches;
      } else if (rule.matchType === MatchTypes.QUERY) {
        matches = hasSelectedQueryKey(new URL(urlStr).search, rule.pattern);
      } else if (rule.matchType === MatchTypes.REGEX) {
        const regex = compileSafeRegex(rule.pattern);
        matches = regex ? regex.test(urlStr) : false;
      }
    } catch (e) {
      console.warn('[HistoryFilter] Rule evaluation error');
    }

    if (matches) {
      if (rule.action === ActionTypes.BLOCK) {
        return { action: ActionTypes.BLOCK, ruleName: rule.name || rule.id || 'Unnamed rule' };
      }

      if (rule.action === ActionTypes.NORMALIZE) {
        return {
          action: ActionTypes.NORMALIZE,
          ruleName: rule.name || rule.id || 'Unnamed rule',
          normalizedUrl: normalizeUrl(urlStr, rule.normalizeOptions)
        };
      }
    }
  }

  return null;
}
