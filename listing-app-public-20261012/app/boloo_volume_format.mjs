/** Parse the official Boloo UI's locale-formatted monthly volume as a number. */
export function parseDisplayedVolume(value) {
  const raw = String(value ?? '').trim().replace(/\s/g, '');
  if (!raw) return null;
  const comma = raw.lastIndexOf(',');
  const dot = raw.lastIndexOf('.');
  let normalized = raw;
  if (comma >= 0 && dot >= 0) {
    const decimal = comma > dot ? ',' : '.';
    normalized = raw.replace(decimal === ',' ? /\./g : /,/g, '').replace(decimal, '.');
  } else if (comma >= 0) {
    normalized = /,\d{1,2}$/.test(raw) ? raw.replace(',', '.') : raw.replace(/,/g, '');
  } else if ((raw.match(/\./g) || []).length > 1 || /\.\d{3}$/.test(raw)) {
    normalized = raw.replace(/\./g, '');
  }
  const parsed = Number(normalized);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export function matchesDisplayedVolume(displayedValue, structuredVolume) {
  return Number.isFinite(structuredVolume) && structuredVolume >= 0
    && parseDisplayedVolume(displayedValue) === structuredVolume;
}
