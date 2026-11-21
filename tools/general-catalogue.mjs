import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const source = 'https://www.sanguosha.com/hero';
const heroRoute = /^https:\/\/(?:www\.)?sanguosha\.com\/hero\/(\d+)$/;
const artworkRoute = /^https:\/\/web\.sanguosha\.com\/{1,2}220\/miniGame\/release\/laya2\/res\/runtime\/m\/general\/big\/static\/\d+\.png$/;
const artworkBase = 'https://web.sanguosha.com//220/miniGame/release/laya2/res/runtime/m/general/big/static/';
const day = 24 * 60 * 60 * 1000;
const maxPageBytes = 8 * 1024 * 1024;

function general(id, name, portraitUrl) {
  if (!Number.isSafeInteger(id) || id <= 0 || typeof name !== 'string' || !name.trim() || name.length > 60
    || typeof portraitUrl !== 'string' || !artworkRoute.test(portraitUrl)) throw new Error('武将目录条目无效');
  return { id, name: name.trim(), portraitUrl, avatarUrl: portraitUrl.replace('/general/big/static/', '/general/skinShop/') };
}

export function parseGeneralCatalogue(html) {
  for (const [, content] of html.matchAll(/<script\b[^>]*\btype=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    const list = JSON.parse(content);
    if (list?.['@type'] !== 'ItemList' || !Array.isArray(list.itemListElement)) continue;
    const rows = list.itemListElement;
    if (!rows.length || rows.length !== list.numberOfItems) throw new Error('武将目录条数不完整');
    const entries = new Map(rows.map(row => {
      const id = Number(heroRoute.exec(row?.url)?.[1]);
      return [id, general(id, row?.item?.name, row?.item?.image)];
    }));
    if (entries.size !== rows.length) throw new Error('武将目录 ID 重复');
    return entries;
  }
  throw new Error('官网未返回武将目录');
}

async function readCataloguePage(fetcher, signal) {
  const response = await fetcher(source, { signal, redirect: 'error', credentials: 'omit', cache: 'no-cache' });
  if (!response.ok) throw new Error(`官网返回 HTTP ${response.status}`);
  if (!response.body || Number(response.headers.get('content-length')) > maxPageBytes) {
    await response.body?.cancel();
    throw new Error('武将目录响应为空或过大');
  }
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const text = [];
  let length = 0;
  for await (const chunk of response.body) {
    length += chunk.byteLength;
    if (length > maxPageBytes) throw new Error('武将目录响应过大');
    text.push(decoder.decode(chunk, { stream: true }));
  }
  text.push(decoder.decode());
  return parseGeneralCatalogue(text.join(''));
}

export async function openGeneralCatalogue(file, { fetcher = fetch, interval = day, onError = console.warn } = {}) {
  // These recorded IDs are absent from the web directory. The official client character table confirms their avatar IDs.
  let entries = new Map([[708, '界孙鲁班'], [766, '界关平']]
    .map(([id, name]) => [id, general(id, name, `${artworkBase}${id * 100}.png`)]));
  let timer, inFlight;
  const lifetime = new AbortController();
  try {
    const saved = JSON.parse(await readFile(file, 'utf8'));
    if (saved.schemaVersion !== 1 || !Array.isArray(saved.generals)) throw new Error('武将索引格式无效');
    entries = new Map([...entries, ...saved.generals.map(({ id, name, portraitUrl }) => [id, general(id, name, portraitUrl)])]);
  } catch (error) {
    if (error.code !== 'ENOENT') onError(`读取武将索引失败 · ${error.message}`);
  }

  async function refresh() {
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(20000)]);
      const incoming = await readCataloguePage(fetcher, signal);
      const next = new Map([...entries, ...incoming]);
      signal.throwIfAborted();
      await mkdir(dirname(file), { recursive: true });
      await writeFile(temporary, JSON.stringify({ schemaVersion: 1, updatedAt: Date.now(), generals: [...next.values()] }));
      signal.throwIfAborted();
      await rename(temporary, file);
      entries = next;
    } catch (error) {
      await unlink(temporary).catch(() => {});
      if (!lifetime.signal.aborted) onError(`刷新武将索引失败 · ${error.message}`);
    }
  }

  function tick() {
    inFlight ??= refresh().finally(() => { inFlight = undefined; });
    return inFlight;
  }

  return {
    get: id => entries.get(id),
    start() {
      if (timer || lifetime.signal.aborted) return;
      void tick();
      timer = setInterval(tick, interval).unref();
    },
    stop() {
      clearInterval(timer);
      lifetime.abort();
      return inFlight;
    },
  };
}
