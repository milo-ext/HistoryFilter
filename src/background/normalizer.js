import { removeSelectedQueryKeys } from '../shared/query-selectors.js';

export function normalizeUrl(urlStr, options = {}) {
  try {
    const url = new URL(urlStr);

    // 1. Custom fixed URL (highest priority)
    if (options.customFixedUrl) {
      return new URL(options.customFixedUrl).toString();
    }

    // 2. Keep Origin Only (e.g., https://example.com/)
    if (options.keepOriginOnly) {
      return url.origin + '/';
    }

    // 3. Keep Origin + Path (Strip query and hash)
    if (options.keepOriginAndPath) {
      url.search = '';
      url.hash = '';
      return url.toString();
    }

    // Remove only named tracking keys. Work on raw query segments so the
    // remaining values, encodings, duplicate keys, order, and hash survive.
    if (options.stripSelectedQueryKeys) {
      return removeSelectedQueryKeys(urlStr, options.stripSelectedQueryKeys);
    }

    // 4. Strip ALL query params
    if (options.stripAllQueryParams) {
      url.search = '';
    }
    // 5. Keep only selected query keys
    else if (options.keepSelectedQueryKeys && Array.isArray(options.keepSelectedQueryKeys)) {
      const params = new URLSearchParams(url.search);
      const newParams = new URLSearchParams();

      options.keepSelectedQueryKeys.forEach(key => {
        if (params.has(key)) {
          const values = params.getAll(key);
          values.forEach(v => newParams.append(key, v));
        }
      });

      url.search = newParams.toString() ? '?' + newParams.toString() : '';
    }

    return url.toString();
  } catch (err) {
    return null;
  }
}
