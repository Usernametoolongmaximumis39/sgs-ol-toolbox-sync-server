import { CARDS_ICON, DAILY_REWARDS_ICON, EFFECTS_ICON, SHANHETU_ICON, SKINS_ICON, THEMES_ICON, TOOLBOX_ICON } from './plugin-icons.js';

// Shared monochrome 24x24 icons. Package metadata never supplies raw markup.
const markup = Object.freeze({
  cards: CARDS_ICON,
  gift: DAILY_REWARDS_ICON,
  effects: EFFECTS_ICON,
  skins: SKINS_ICON,
  palette: THEMES_ICON,
  typography: '<path d="M3 19 9 5l6 14M5 14h8M16 9h6M19 9v10M16 19h6"/>',
  toolbox: TOOLBOX_ICON,
  map: SHANHETU_ICON,
  tools: '<rect x="3" y="7" width="18" height="14" rx="3"/><path d="M8 7V4h8v3M3 12h18M10 11v3h4v-3"/>',
  settings: '<path d="M12 3l2 3 4-1 1 4 3 3-3 3-1 4-4-1-2 3-2-3-4 1-1-4-3-3 3-3 1-4 4 1z"/><circle cx="12" cy="12" r="3"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 10v7M12 6v1"/>',
  search: '<circle cx="10.5" cy="10.5" r="5.5"/><path d="m15 15 4.5 4.5"/>',
  package: '<path d="m12 3 9 5v9l-9 5-9-5V8zM3 8l9 5 9-5M12 13v9M7 5l10 5v4"/>',
  automation: '<path d="M13 2L4 14h7l-1 8 10-13h-7z"/>',
  refresh: '<path d="M20 8a8 8 0 1 0 0 8M20 3v5h-5"/>',
  reset: '<path d="M8 4 3 9l5 5M3 9h10a6 6 0 0 1 0 12"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  camera: '<path d="M8 6.5 9.5 4h5L16 6.5h3.5a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-15a2 2 0 0 1-2-2v-10a2 2 0 0 1 2-2Z"/><circle cx="12" cy="13" r="3.5"/><path d="M18 10h.01"/>',
  expand: '<path d="M14 4h6v6m0-6-6.5 6.5M10 20H4v-6m0 6 6.5-6.5"/>',
  collapse: '<path d="M5 12h14"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  save: '<path d="M5 3h12l4 4v14H3V3zM7 3v6h10V3M7 21v-8h10v8"/>',
  download: '<path d="M12 3v12m-4-4 4 4 4-4M4 16v5h16v-5"/>',
  arrowUp: '<path d="M12 20V4m-6 6 6-6 6 6"/>',
  arrowDown: '<path d="M12 4v16m-6-6 6 6 6-6"/>',
  pointer: '<path d="m5 3 14 9-7 1-3 7z"/>',
  clipboard: '<path d="M9 5H5v16h14V5h-4M9 3h6v4H9zM8 12h8M8 16h6"/>',
  share: '<circle cx="6" cy="12" r="3"/><circle cx="18" cy="5" r="3"/><circle cx="18" cy="19" r="3"/><path d="m9 10 6-4M9 14l6 4"/>',
  play: '<path d="m8 5 11 7-11 7z"/>', pause: '<path d="M8 5v14M16 5v14"/>',
  trash: '<path d="M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7"/>',
  update: '<path d="M12 16V3m-5 5 5-5 5 5M4 16v5h16v-5"/>',
  check: '<path d="m5 12 4 4L19 6"/>', alert: '<path d="m12 3 10 18H2zM12 9v5M12 17v1"/>',
});
const aliases = Object.freeze({ game: 'cards', manage: 'settings', reload: 'refresh', rollback: 'reset' });
export const ICON_NAMES = Object.freeze([...Object.keys(markup), ...Object.keys(aliases)]);
export function isIconSpec(value) {
  if (typeof value === 'string') return Object.hasOwn(markup, value) || Object.hasOwn(aliases, value);
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === 1 && Array.isArray(value.paths) && value.paths.length >= 1 && value.paths.length <= 8
    && value.paths.every(path => typeof path === 'string' && path.length <= 1024 && /^[Mm][\s\d.,+\-eEMmLlHhVvCcSsQqTtAaZz]+$/.test(path) && /\d/.test(path));
}
export function createIcon(doc, value = 'package', className = 'sgs-line-icon') {
  const spec = isIconSpec(value) ? value : 'package', icon = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.setAttribute('viewBox', '0 0 24 24'); icon.setAttribute('class', className); icon.setAttribute('aria-hidden', 'true');
  icon.setAttribute('focusable', 'false'); icon.setAttribute('fill', 'none'); icon.setAttribute('stroke', 'currentColor');
  icon.setAttribute('stroke-width', '1.5'); icon.setAttribute('stroke-linecap', 'round'); icon.setAttribute('stroke-linejoin', 'round');
  icon.dataset.icon = typeof spec === 'string' ? spec : 'custom';
  const shape = typeof spec === 'string' ? markup[aliases[spec] || spec] : spec;
  if (typeof shape === 'string') icon.innerHTML = shape;
  else for (const d of shape.paths) { const path = doc.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('d', d); icon.append(path); }
  return icon;
}
