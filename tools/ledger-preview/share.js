import { publicRecordText, readPublicRecords, readPublicView } from './public-sync-view.js';

const $ = id => document.getElementById(id);
const form = $('unlock'), password = $('view-pass'), submit = form.querySelector('button');
const streams = document.querySelectorAll('[data-stream]');
const records = { events: [], matches: [] };
const pageSize = 20;
let stream = 'events', page = 0;

function showError(message) {
  $('error').textContent = message;
  $('error').hidden = !message;
}

function readShare(code) {
  const share = readPublicView(code);
  if (share.origin !== location.origin) throw new Error('请在分享链接对应的 HTTPS 服务器打开预览');
  return share;
}

function draw() {
  const rows = records[stream], pages = Math.max(1, Math.ceil(rows.length / pageSize));
  page = Math.max(0, Math.min(page, pages - 1));
  for (const button of streams) button.setAttribute('aria-pressed', String(button.dataset.stream === stream));
  $('summary').textContent = rows.length ? `${rows.length.toLocaleString()} 条` : '暂无记录';
  $('rows').replaceChildren(...rows.slice(page * pageSize, (page + 1) * pageSize).map(({ id, details, at }) => {
    const row = document.createElement('li');
    row.className = 'row';
    const text = document.createElement('p'), time = document.createElement('time');
    text.textContent = publicRecordText(stream, details);
    time.textContent = (at ? new Date(at).toLocaleString() + ' · ' : '') + id;
    row.append(text, time);
    return row;
  }));
  $('page').textContent = `第 ${page + 1} / ${pages} 页`;
  $('prev').disabled = page === 0;
  $('next').disabled = page + 1 === pages;
  $('pages').hidden = pages <= 1;
}

const messages = {
  invalid_view: '查看码错误或分享凭据无效',
  view_locked: '查看尝试次数过多，请在 30 分钟后重试',
  public_preview_disabled: '服务器管理员已关闭公共预览',
};
async function post(origin, path, body) {
  const response = await fetch(origin + path, { method: 'POST', credentials: 'omit', redirect: 'error', cache: 'no-store',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .catch(() => { throw new Error('暂时无法连接同步服务器'); });
  const data = await response.json().catch(() => { throw new Error('暂时无法读取分享记录'); });
  if (!response.ok) throw new Error(Object.hasOwn(messages, data.error) ? messages[data.error] : '暂时无法读取分享记录');
  return data;
}

function readLink() {
  let share;
  try { if (location.hash) share = readShare(location.href); }
  catch (error) { showError(error.message); }
  $('share-code-field').hidden = Boolean(share);
  $('share-code').required = !share;
  return share;
}

if (document.body.hasAttribute('data-preview-disabled')) {
  showError(messages.public_preview_disabled);
} else {
  const link = readLink();
  form.hidden = false;
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (submit.disabled) return;
    submit.disabled = true;
    submit.textContent = '正在解密…';
    showError('');
    try {
      const share = link ?? readShare($('share-code').value);
      const decrypted = await readPublicRecords(crypto, post, share, password.value);
      records.events = [];
      records.matches = [];
      for (const [kind, id, details] of decrypted) {
        if (!details || typeof details !== 'object') continue;
        const key = kind === 'event' ? 'events' : 'matches';
        records[key].push({ id, details, at: Number(kind === 'event' ? details.at : details.endedAt) || 0 });
      }
      for (const rows of Object.values(records)) rows.sort((a, b) => b.at - a.at);
      draw();
      form.hidden = true;
      $('unlock-hint').hidden = true;
      $('shared-history').hidden = false;
      document.querySelector('[data-stream="events"]').focus();
    } catch (error) {
      showError(error.message);
      password.focus();
    } finally {
      password.value = '';
      submit.disabled = false;
      submit.textContent = '解密并查看';
    }
  });
  for (const button of streams) button.addEventListener('click', () => { stream = button.dataset.stream; page = 0; draw(); });
  $('prev').addEventListener('click', () => { page--; draw(); });
  $('next').addEventListener('click', () => { page++; draw(); });
}
