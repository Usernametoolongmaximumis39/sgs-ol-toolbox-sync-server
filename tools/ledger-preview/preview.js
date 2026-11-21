const byId = id => document.getElementById(id);
const elements = Object.fromEntries(['sync-time', 'account', 'account-search', 'reload', 'error', 'balances', 'search', 'summary', 'rows',
  'pages', 'prev', 'page', 'next', 'from', 'to', 'period', 'kind', 'export', 'amounts',
  'filters', 'match-mode', 'match-side', 'match-result', 'match-frame'].map(id => [id, byId(id)]));
const tabs = [...document.querySelectorAll('[data-stream]')];
const eventFilters = [...document.querySelectorAll('[data-event-filter]')];
const matchFilters = [...document.querySelectorAll('[data-match-filter]')];
const number = new Intl.NumberFormat('zh-CN');
const clock = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'medium', hour12: false });
const balanceIconRoot = 'https://web.sanguosha.com//220/miniGame/release/laya2/res/runtime/m/shop/GiveBuy/';
// PicID values from the game's goods table. The active 如意结 variants share artwork.
const balanceIconIds = new Map([
  ['元宝', 70], ['传世玉玺', 33059], ['祈福灯', 80042], ['绘卷毛笔', 33414],
  ['秘钥', 33747], ['密钥', 33747], ['玉玺碎片', 33424], ['如意结', 33700],
]);
let current = null, stream = 'events', page = 1, active, searchTimer, expiryTimer, layoutFrame;

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function timestamp(at) {
  const element = node('time', clock.format(at));
  element.dateTime = new Date(at).toISOString();
  return element;
}

function balance(row) {
  const card = node('div', undefined, 'balance');
  const name = node('span', undefined, 'balance-name');
  name.append(node('span', row.name));
  if (row.name === '如意结') name.append(node('small', row.id, 'balance-id'));
  name.title = `物品 ID ${row.id}`;
  card.append(name, node('strong', number.format(row.count)), timestamp(row.at));
  const iconId = balanceIconIds.get(row.name);
  if (iconId) {
    const image = node('img', undefined, 'balance-icon');
    image.alt = '';
    image.decoding = 'async';
    image.addEventListener('error', () => { image.hidden = true; }, { once: true });
    image.src = `${balanceIconRoot}${iconId}.png`;
    card.append(image);
  }
  if (row.review) card.append(node('small', '同时间数量不一致 · 待核对', 'balance-review'));
  return card;
}

function arrangeBalances(cards, resizing = false) {
  const grid = elements.balances;
  const gap = parseFloat(getComputedStyle(grid).columnGap);
  const capacity = Math.max(1, Math.floor((grid.getBoundingClientRect().width + gap) / (130 + gap)));
  const rowCount = Math.min(cards.length, Math.max(2, Math.ceil(cards.length / capacity)));
  if (resizing && grid.childElementCount === rowCount) return;
  const perRow = Math.floor(cards.length / rowCount), extra = cards.length % rowCount;
  let start = 0;
  const rows = Array.from({ length: rowCount }, (_, index) => {
    const group = node('div', undefined, 'balance-row');
    const end = start + perRow + Number(index < extra);
    group.append(...cards.slice(start, end));
    start = end;
    return group;
  });
  grid.replaceChildren(...rows);
}

function drawBalances(rows) {
  clearTimeout(expiryTimer);
  const now = Date.now(), available = rows.filter(row => !row.expiresAt || row.expiresAt > now);
  if (available.length) arrangeBalances(available.map(balance));
  else elements.balances.replaceChildren(node('p', '暂无已观察的数量', 'muted'));
  const next = Math.min(Infinity, ...available.flatMap(row => row.expiresAt ? [row.expiresAt] : []));
  if (Number.isFinite(next)) expiryTimer = setTimeout(() => drawBalances(available), Math.min(next - now, 2147483647));
}

function eventRow(row) {
  const article = node('li', undefined, 'row'), heading = node('div', undefined, 'row-head');
  const source = { DbsCcUserGoodshintNtf: '物品到账通知', DbsCcUpdategoodsAttribNtf: '背包数量变化',
    DbsCcUserDelgoodsNtf: '背包物品移除', DbsCUpdatauserYaunbaoNtf: '元宝变动', decodeClientSecretExploreRep: '祈愿确认' };
  heading.append(node('strong', row.type === 2010 ? '祈愿奖励到账' : source[row.source]), timestamp(row.at));
  const items = node('p', undefined, 'items');
  for (const item of row.items) {
    const change = node('span', `${item.name} ${item.delta > 0 ? '+' : '−'}${number.format(Math.abs(item.delta))}`, item.delta > 0 ? 'gain' : '');
    change.title = `物品 ID ${item.id}`;
    items.append(change);
  }
  if (row.prayer) items.append(node('span', `${row.prayer.name} · ${number.format(row.prayer.times)} 次`));
  article.append(heading, items);
  const details = node('details');
  details.append(node('summary', '查看流水详情'), node('pre', JSON.stringify(row, null, 2)));
  article.append(details);
  return article;
}

function generalRowMargins(widths, available, gap) {
  const length = widths.length, margins = Array(length).fill(0);
  const total = widths.reduce((sum, width) => sum + width, gap * (length - 1));
  if (total <= available) return margins;

  const lines = Array(length + 1).fill(Infinity), costs = [...lines];
  const breaks = [], remaining = [];
  lines[length] = costs[length] = 0;
  // Use the fewest rows, then minimize the variance in the number of generals per row.
  for (let start = length - 1; start >= 0; start--) {
    let used = -gap;
    for (let index = start; index < length; index++) {
      used += gap + Math.min(widths[index], available);
      if (used > available) break;
      const end = index + 1;
      const count = end - start;
      const lineCount = lines[end] + 1, cost = costs[end] + count * count;
      if (lineCount < lines[start] || lineCount === lines[start] && cost <= costs[start]) {
        lines[start] = lineCount;
        costs[start] = cost;
        breaks[start] = end;
        remaining[start] = available - used;
      }
    }
  }
  for (let start = 0; breaks[start] < length; start = breaks[start]) {
    // Fill the end of this flex line, with a pixel left for layout rounding.
    margins[breaks[start] - 1] = Math.max(0, remaining[start] - 1);
  }
  return margins;
}

function layoutGenerals() {
  const layouts = [];
  for (const list of elements.rows.querySelectorAll('.general-list')) {
    const items = [...list.children], available = list.getBoundingClientRect().width;
    if (items.length < 2 || !available) continue;
    const widths = items.map(item => item.getBoundingClientRect().width);
    const margins = generalRowMargins(widths, available, parseFloat(getComputedStyle(list).columnGap));
    layouts.push({ items, margins });
  }
  for (const { items, margins } of layouts) {
    items.forEach((item, index) => {
      const margin = margins[index] ? `${margins[index]}px` : '';
      if (item.style.marginInlineEnd !== margin) item.style.marginInlineEnd = margin;
    });
  }
}

function scheduleLayout() {
  layoutFrame ??= requestAnimationFrame(() => {
    layoutFrame = undefined;
    const cards = [...elements.balances.querySelectorAll('.balance')];
    if (cards.length) arrangeBalances(cards, true);
    layoutGenerals();
  });
}

function generalList(label, generals) {
  const section = node('div', undefined, 'match-generals');
  const list = node('ul', undefined, 'general-list');
  list.setAttribute('aria-label', label);
  for (const { id, name, avatarUrl, portraitUrl } of generals) {
    const item = node('li', undefined, 'general');
    item.title = `${name} · 武将 #${id}`;
    const avatar = node('span', '将', 'general-avatar');
    avatar.setAttribute('aria-hidden', 'true');
    if (avatarUrl) {
      const image = node('img');
      image.alt = '';
      image.loading = 'lazy';
      image.decoding = 'async';
      let fallback = portraitUrl;
      image.addEventListener('error', () => {
        if (fallback) {
          image.src = fallback;
          fallback = null;
        } else image.remove();
      });
      image.src = avatarUrl;
      avatar.append(image);
    }
    item.append(avatar, node('span', name, 'general-name'));
    list.append(item);
  }
  section.append(node('span', label, 'general-label'), list);
  return section;
}

function matchRow(row) {
  const article = node('li', undefined, 'row'), heading = node('div', undefined, 'row-head');
  const title = node('strong', `${row.mode} · ${row.side} · `);
  title.append(node('span', row.result === 0 ? '胜' : row.result === 1 ? '负' : '平', row.result === 0 ? 'win' : row.result === 1 ? 'loss' : ''));
  heading.append(title, timestamp(row.endedAt));
  article.append(heading, generalList('出场', row.generalDetails),
    row.frameDetails ? generalList('出框', row.frameDetails) : node('p', '暂无已核实的出框', 'muted'));
  return article;
}

function draw(data) {
  current = data.account;
  page = data.page;
  elements.account.replaceChildren(...data.accounts.map(row => new Option(row.label, row.key)));
  if (current) elements.account.value = current;
  elements.account.parentElement.hidden = data.accounts.length === 0;
  elements['sync-time'].textContent = !data.accounts.length && elements['account-search'].value.trim() ? '没有匹配的账号'
    : data.updatedAt ? `上次账本同步 ${clock.format(data.updatedAt)}` : '暂无账本余额与流水同步';
  drawBalances(data.balances);
  const { summary } = data;
  const played = summary.wins + summary.losses;
  const winRate = played ? ` · 胜率 ${(summary.wins / played * 100).toFixed(1)}%` : '';
  elements.summary.textContent = stream === 'events'
    ? `筛选结果 ${number.format(data.count)} / ${number.format(summary.events)} 条已知流水`
    : stream === 'review' ? `筛选结果 ${number.format(data.count)} / ${number.format(summary.review)} 条待核对 · 暂未计入已知流水`
      : `战绩 ${number.format(summary.matches)} 局 · 出框 ${number.format(summary.frames)} 局 · ${summary.wins} 胜 ${summary.losses} 负 ${summary.draws} 平${winRate}`;
  if (stream !== 'matches' && elements.period.value === 'session')
    elements.summary.textContent += data.latestLogin ? ` · 登录于 ${clock.format(data.latestLogin)}` : ' · 暂无已同步的登录时间';
  elements.amounts.replaceChildren(...data.amounts.map(({ id, name, income, expense }) => {
    const card = node('div');
    card.title = `物品 ID ${id}`;
    card.append(node('strong', name), node('small', `收入 +${number.format(income)} · 消耗 −${number.format(expense)}`));
    return card;
  }));
  elements.amounts.hidden = !data.amounts.length;
  elements.export.disabled = !data.count;
  const renderRow = stream === 'matches' ? matchRow : eventRow;
  const filtered = elements.search.value.trim() || elements.from.value || elements.to.value ||
    (stream === 'matches' ? Object.entries(battleFilters()).some(([key, value]) => key === 'mode' ? value !== 0 : value !== 'all')
      : elements.period.value !== 'all' || elements.kind.value !== 'all');
  elements.rows.replaceChildren(...(data.rows.length ? data.rows.map(renderRow)
    : [node('li', filtered ? '没有匹配的记录' : '暂无记录', 'row muted')]));
  if (stream === 'matches') scheduleLayout();
  elements.pages.hidden = data.pages < 2;
  elements.prev.disabled = page <= 1;
  elements.next.disabled = page >= data.pages;
  elements.page.textContent = `${page} / ${data.pages}`;
}

function battleFilters() {
  return { mode: Number(elements['match-mode'].value), side: elements['match-side'].value,
    result: elements['match-result'].value, frame: elements['match-frame'].value };
}

function updateSides() {
  const { mode, side } = battleFilters();
  const options = [['全部', 'all']];
  if (mode !== 35) options.push([mode === 26 ? '先手（1、4）' : '先手', 'first'],
    [mode === 26 ? '后手（2、3）' : '后手', 'second']);
  if (mode === 0 || mode === 35) options.push(['地主', 'landlord'], ['农民', 'farmer']);
  elements['match-side'].replaceChildren(...options.map(([label, value]) => new Option(label, value)));
  if (options.some(([, value]) => value === side)) elements['match-side'].value = side;
}

function filters() {
  const from = elements.from.value ? new Date(elements.from.value).getTime() : 0;
  const to = elements.to.value ? new Date(elements.to.value).getTime() : 8640000000000000;
  if (to < from) throw new Error('结束时间须晚于或等于开始时间');
  return { account: current || undefined, accountQuery: elements['account-search'].value, stream, page,
    from, to, period: elements.period.value, kind: elements.kind.value, query: elements.search.value,
    ...(stream === 'matches' ? { battle: battleFilters() } : {}) };
}

async function read(data, signal) {
  const view = new URLSearchParams(location.search).get('view');
  const response = await fetch('/ledger/read' + (view ? '?view=' + encodeURIComponent(view) : ''), { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data), signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function load() {
  active?.abort();
  const task = active = new AbortController();
  elements.error.hidden = true;
  elements.rows.setAttribute('aria-busy', 'true');
  try {
    const data = await read(filters(), task.signal);
    if (active === task) draw(data);
  } catch (error) {
    if (active === task) {
      elements.error.textContent = `预览读取失败 · ${error.message}`;
      elements.error.hidden = false;
    }
  } finally { if (active === task) elements.rows.removeAttribute('aria-busy'); }
}

function clearRows() {
  elements.rows.replaceChildren();
  elements.summary.textContent = '';
  elements.pages.hidden = true;
  elements.export.disabled = true;
  elements.amounts.hidden = true;
}
function changeAccount(account) {
  current = account; page = 1;
  clearTimeout(expiryTimer);
  elements.balances.replaceChildren();
  elements['sync-time'].textContent = '正在读取本机记录…';
  clearRows(); void load();
}
elements.account.addEventListener('change', () => changeAccount(elements.account.value));
elements['account-search'].addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => changeAccount(null), 150);
});
elements.reload.addEventListener('click', () => void load());
elements.prev.addEventListener('click', () => { page--; void load(); });
elements.next.addEventListener('click', () => { page++; void load(); });
elements.search.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { page = 1; void load(); }, 150);
});
for (const filter of [elements.from, elements.to, elements.kind, elements.period, ...matchFilters.map(label => label.querySelector('select'))]) {
  filter.addEventListener('change', () => {
    if (filter === elements['match-mode']) updateSides();
    page = 1; clearRows(); void load();
  });
}
elements.export.addEventListener('click', async () => {
  const selection = current;
  try {
    const data = await read({ ...filters(), export: true });
    if (selection !== current || !data.rows.length) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const link = node('a');
    link.href = url;
    link.download = `${data.stream === 'matches' ? '战绩与出框' : '账本'}-${data.account?.userCode ?? '查询结果'}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) {
    elements.error.textContent = `导出失败 · ${error.message}`;
    elements.error.hidden = false;
  }
});
for (const tab of tabs) tab.addEventListener('click', () => {
  if (stream === tab.dataset.stream) return;
  stream = tab.dataset.stream;
  for (const button of tabs) button.setAttribute('aria-pressed', String(button === tab));
  for (const filter of eventFilters) filter.hidden = stream === 'matches';
  for (const filter of matchFilters) filter.hidden = stream !== 'matches';
  elements.filters.classList.toggle('match-filters', stream === 'matches');
  elements.search.value = '';
  elements.search.placeholder = stream === 'matches' ? '武将或模式' : '道具名称或 ID';
  page = 1; clearRows(); void load();
});
updateSides();
const layoutObserver = new ResizeObserver(scheduleLayout);
layoutObserver.observe(elements.rows);
layoutObserver.observe(elements.balances);
document.fonts?.addEventListener('loadingdone', scheduleLayout);
void load();
