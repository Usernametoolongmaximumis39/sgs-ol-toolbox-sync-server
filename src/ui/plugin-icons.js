// Plugin identities travel with the manifest as contract-v1 path specs, so older
// cores can draw the same artwork without knowing any new public icon names.
const icon = (...paths) => Object.freeze({ paths: Object.freeze(paths) });

// Export each icon independently so a plugin package only carries its own paths.
export const CARDS_ICON = /* @__PURE__ */ icon(
  'M9 3h10a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z',
  'M4 5 2 6l2 14M14 7l3 5-3 5-3-5Z',
);

export const SHANHETU_ICON = /* @__PURE__ */ icon(
  'M3 5 9 3l6 2 6-2v16l-6 2-6-2-6 2Z',
  'M6 12 10 7l4 5 3-3 2 3',
  'M6 16c3-3 7 3 12-1',
);

export const SHANHETU_BETA_ICON = /* @__PURE__ */ icon(
  'M3 5 9 3l6 2 6-2v16l-6 2-6-2-6 2Z',
  'M12 7v8m-4-4h8',
);

export const DAILY_REWARDS_ICON = /* @__PURE__ */ icon(
  'M3 8h18v4H3ZM5 12v9h14v-9M12 8v13',
  'M12 8H8a3 3 0 1 1 3-3ZM12 8h4a3 3 0 1 0-3-3Z',
);

export const SECKILL_ICON = /* @__PURE__ */ icon(
  'M5 7h14l2 14H3ZM8 7V5a4 4 0 0 1 8 0v2',
  'M13 10 9 15h3l-1 4 5-6h-4Z',
);

export const GAIZHU_ICON = /* @__PURE__ */ icon(
  'M5 21V3M5 4c5-4 9 4 14 0v10c-5 4-9-4-14 0',
  'M9 9a3 3 0 0 1 5-2l1 2M15 6v3h-3',
  'M2 21h6',
);

export const EFFECTS_ICON = /* @__PURE__ */ icon(
  'M9 5 11 2l2.5 7.5L21 12l-4 1.5M14.5 16 12 22l-2.5-7.5L2 12l5-2',
  'M3 3 21 21M19 3v4M17 5h4',
);

export const SKINS_ICON = /* @__PURE__ */ icon(
  'M8 3 12 5l4-2 6 5-4 4-2-2v11H8V10l-2 2-4-4Z',
  'M8 3l8 9M16 3l-6 7M8 16h8',
);

export const WISH_PROGRESS_ICON = /* @__PURE__ */ icon(
  'M12 17 4.5 10a4.3 4.3 0 0 1 6-6L12 5.5 13.5 4a4.3 4.3 0 0 1 6 6Z',
  'M4 21h9M16 21h4',
);

export const THEMES_ICON = /* @__PURE__ */ icon(
  'M12 21 2 8a16 16 0 0 1 20 0Z',
  'M12 21 7 5.3M12 21V4.5M12 21 17 5.3',
  'M10 19a3 3 0 0 1 4 0',
);

export const BAISHENG_ICON = /* @__PURE__ */ icon(
  'M7 3h10v6a5 5 0 0 1-10 0ZM7 5H3v2a4 4 0 0 0 4 4M17 5h4v2a4 4 0 0 1-4 4',
  'M12 14v4M8 21v-3h8v3ZM12 6l2 2-2 2-2-2Z',
);

export const APPEARANCES_ICON = /* @__PURE__ */ icon(
  'M9 21H3V3h18v9',
  'M9 6a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5ZM5.5 16v-1a3.5 3.5 0 0 1 7-1',
  'M12 21 16 17l3 2 3-5M19 14h3v3',
);

export const LEDGER_ICON = /* @__PURE__ */ icon(
  'M6 3h13a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2ZM8 3v18',
  'M2 7h4M2 12h4M2 17h4M12 8h5M12 12h5M12 16h3',
);

export const PLUGIN_ICONS = /* @__PURE__ */ Object.freeze({
  cards: CARDS_ICON,
  shanhetu: SHANHETU_ICON,
  'shanhetu-beta': SHANHETU_BETA_ICON,
  'daily-rewards': DAILY_REWARDS_ICON,
  seckill: SECKILL_ICON,
  gaizhu: GAIZHU_ICON,
  effects: EFFECTS_ICON,
  skins: SKINS_ICON,
  'wish-progress': WISH_PROGRESS_ICON,
  themes: THEMES_ICON,
  baisheng: BAISHENG_ICON,
  appearances: APPEARANCES_ICON,
  ledger: LEDGER_ICON,
});

// Toolbox identity is separate from the remaining-Slash counter's “杀” label.
export const TOOLBOX_ICON = /* @__PURE__ */ icon(
  'M3 7h18v13H3ZM8 7V4h8v3M3 12h6M15 12h6',
  'M12 9l3 3-3 3-3-3Z',
);
