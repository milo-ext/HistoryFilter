// Query-key selectors are case-sensitive decoded names. A trailing * matches
// any key beginning with the preceding characters; * alone is not allowed.
export function parseQuerySelectors(input) {
  const parts = Array.isArray(input) ? input : typeof input === 'string' ? input.split(',') : [];
  if (!parts.length) return null;
  const selectors = [];
  for (const part of parts) {
    if (typeof part !== 'string') return null;
    const selector = part.trim();
    if (!selector || selector === '*' || /[,&=?#\s]/.test(selector) ||
        (selector.includes('*') && !/^[^*]+\*$/.test(selector))) return null;
    if (!selectors.includes(selector)) selectors.push(selector);
  }
  return selectors;
}

export function matchesQuerySelector(key, selector) {
  return selector.endsWith('*')
    ? key.startsWith(selector.slice(0, -1))
    : key === selector;
}

export function hasSelectedQueryKey(search, input) {
  const selectors = parseQuerySelectors(input);
  if (!selectors) return false;
  for (const key of new URLSearchParams(search).keys()) {
    if (selectors.some(selector => matchesQuerySelector(key, selector))) return true;
  }
  return false;
}

export function removeSelectedQueryKeys(urlString, input) {
  const selectors = parseQuerySelectors(input);
  if (!selectors) return null;
  const hashIndex = urlString.indexOf('#');
  const queryIndex = urlString.indexOf('?');
  if (queryIndex === -1 || (hashIndex !== -1 && queryIndex > hashIndex)) return urlString;
  const queryEnd = hashIndex === -1 ? urlString.length : hashIndex;
  const segments = urlString.slice(queryIndex + 1, queryEnd).split('&');
  let removed = false;
  const kept = segments.filter(segment => {
    const rawKey = segment.split('=', 1)[0];
    const key = new URLSearchParams(`${rawKey}=`).keys().next().value;
    const selected = selectors.some(selector => matchesQuerySelector(key, selector));
    if (selected) removed = true;
    return !selected;
  });
  if (!removed) return urlString;
  const query = kept.some(segment => segment !== '') ? `?${kept.join('&')}` : '';
  return urlString.slice(0, queryIndex) + query + urlString.slice(queryEnd);
}
