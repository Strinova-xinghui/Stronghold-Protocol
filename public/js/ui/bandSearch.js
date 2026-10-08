// 策略搜索 (2026-10-08): pure matching helpers for the strategy draft's search bar (js/screens/bandDraft.js).
// Zero imports on purpose — node --test imports this file directly (bandDraft.js drags the whole DOM dependency
// chain: vendor hooks → ui components → PixiJS/three → audio, none of which load in Node).

/**
 * The lowercase search haystack of one strategy: name + effect name + description (markup stripped) + the names of
 * the bonds it is built around, resolved by `bondName` (the screen passes gd.bond(id)?.name || id).
 * @param {any} band bands.json record
 * @param {(id: string) => string} [bondName] bondId → display name
 * @returns {string}
 */
export function bandSearchText(band, bondName = (id) => String(id)) {
  if (!band) return '';
  const desc = String(band.descRaw || band.desc || '').replace(/<[^>]*>/g, ' ');
  const bonds = (Array.isArray(band.bondIds) ? band.bondIds : [])
    .filter((id) => typeof id === 'string').map((id) => bondName(id) || id).join(' ');
  return `${band.name || ''} ${band.effectName || ''} ${desc} ${bonds}`.toLowerCase();
}

/**
 * Whether a strategy matches a search query: case-insensitive substring over bandSearchText (empty query matches
 * everything). Display-only — the pick, the timeout and the 队友已选 logic read the full allowed list.
 * @param {any} band bands.json record
 * @param {string} q the trimmed lowercase query
 * @param {Map<string, string>} [texts] bandId → bandSearchText(...) (the screen's memoized haystacks)
 */
export function bandMatchesQuery(band, q, texts) {
  if (!q) return true;
  const hay = (texts instanceof Map ? texts.get(band?.bandId) : bandSearchText(band)) || '';
  return hay.includes(q);
}
