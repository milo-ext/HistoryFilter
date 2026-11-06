// Deliberately small native-RegExp subset: anchored matching, at most one
// repeated single-character atom, and at most eight branch/optional choices.
// No repeated groups, lookarounds, backreferences, or top-level alternatives.
// This bounds backtracking to a constant number of linear scans of the URL.
// Keep validation here shared by the editor, imports, and the runtime engine.
export function compileSafeRegex(pattern) {
  if (typeof pattern !== 'string' || pattern.length > 512 || !pattern.startsWith('^')) return null;
  let depth = 0;
  let choices = 0;
  let repeats = 0;
  let atom = null;
  for (let i = 1; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === '\\') {
      const escaped = pattern[++i];
      if (!escaped) return null;
      if ('dDsSwW'.includes(escaped) || /[\\^$.*+?()[\]{}|/:-]/.test(escaped)) atom = 'character';
      else if ('bB'.includes(escaped)) atom = null;
      else return null;
    } else if (char === '[') {
      let closed = false;
      for (i++; i < pattern.length; i++) {
        if (pattern[i] === '\\') {
          const escaped = pattern[++i];
          if (!escaped || !('dDsSwW'.includes(escaped) || /[\\^$.*+?()[\]{}|/:-]/.test(escaped))) return null;
        } else if (pattern[i] === ']') { closed = true; break; }
      }
      if (!closed) return null;
      atom = 'character';
    } else if (char === '(') {
      if (++depth > 16) return null;
      if (pattern[i + 1] === '?') {
        if (pattern.slice(i + 1, i + 3) !== '?:') return null;
        i += 2;
      }
      atom = null;
    } else if (char === ')') {
      if (--depth < 0) return null;
      atom = 'group';
    } else if (char === '|') {
      if (!depth || ++choices > 8) return null;
      atom = null;
    } else if (char === '?') {
      if (!atom || ++choices > 8) return null;
      atom = null;
    } else if (char === '*' || char === '+' || char === '{') {
      if (atom !== 'character' || ++repeats > 1) return null;
      if (char === '{') {
        const match = pattern.slice(i).match(/^\{(\d{1,3})(?:,(\d{1,3}))?\}/);
        if (!match || Number(match[1]) > 100 || Number(match[2] ?? match[1]) > 100) return null;
        i += match[0].length - 1;
      }
      atom = null;
    } else if (char === '^' || char === '$') {
      atom = null;
    } else if (char === '}' || char === ']') {
      return null;
    } else {
      atom = 'character';
    }
  }
  if (depth) return null;
  try { return new RegExp(pattern, 'i'); } catch { return null; }
}
