import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Script } from 'node:vm';
import { GITHUB_MARKET_URL } from '../../src/core/distribution.js';
import { verifyPackage } from '../../src/core/packages.js';
import { MarketClient } from '../../src/market/client.js';
import { compareVersions } from '../../src/market/updates.js';

const repository = new URL(GITHUB_MARKET_URL).pathname.split('/').slice(1, 3).join('/');
const refUrl = 'https://api.github.com/repos/' + repository + '/git/ref/heads/main';
const raw = 'https://raw.githubusercontent.com/' + repository + '/';
const versionFormat = /^\d+\.\d+\.\d+$/;
const commitFormat = /^[a-f0-9]{40}$/;
const digestFormat = /^[a-f0-9]{64}$/;
const packagePath = /^plugins\/packages\/[a-z][a-z0-9._-]{0,95}\/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?\.json$/;
const liteMetaPath = 'lite/toolbox.meta.js', liteScriptPath = 'lite/toolbox.user.js';
const fixedPaths = new Set(['plugins/catalog.json', liteMetaPath, liteScriptPath, 'microclient/update.json', 'microclient/toolbox.js']);
const retiredPaths = new Set(['full/toolbox.meta.js', 'full/toolbox.user.js']);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const MAX_SCRIPT = 12 * 1024 * 1024;
const REF_TIMEOUT = 20_000;
const ARTIFACT_TIMEOUT = 5 * 60_000;

async function readBody(response, limit) {
  if (!response.ok) throw new Error('GitHub HTTP ' + response.status);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > limit) throw new Error('GitHub 产物超过大小限制');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

function validateUserscript(meta, script, version) {
  const header = meta.toString('utf8').trimEnd();
  if (header.split('\n')[0].trimEnd() !== '// ==UserScript==' || !header.endsWith('// ==/UserScript==')
    || !/^\/\/ @namespace[ \t]+sgs-ol-toolbox\r?$/m.test(header)
    || /^\/\/ @version[ \t]+(\S+)\r?$/m.exec(header)?.[1] !== version
    || !script.toString('utf8').startsWith(header + (header.includes('\r\n') ? '\r\n' : '\n'))) {
    throw new Error('GitHub 核心脚本和元数据版本不一致');
  }
  new Script(script.toString('utf8'));
}

export async function openUpdateMirror({ dataDir, enabled, auto, fetchImpl = globalThis.fetch, token, now = Date.now }) {
  const dir = join(dataDir, 'updates'), objects = join(dir, 'objects'), index = join(dir, 'current.json');
  const shutdown = new AbortController();
  let current, inFlight, timer, etag, lastCheck, error = '';
  try {
    const saved = JSON.parse(await readFile(index, 'utf8'));
    if (!commitFormat.test(saved.commit) || !versionFormat.test(saved.version) || !saved.files) {
      throw new Error('invalid update index');
    }
    const entries = Object.entries(saved.files).filter(([path]) => !retiredPaths.has(path));
    if (!entries.every(([path, digest]) => (fixedPaths.has(path) || packagePath.test(path)) && digestFormat.test(digest))) {
      throw new Error('invalid update index');
    }
    saved.files = Object.fromEntries(entries);
    current = saved;
  } catch (cause) { if (cause.code !== 'ENOENT') error = '本地更新缓存无法读取，等待重新同步'; }
  const request = (url, timeout, headers) => fetchImpl(url, { headers, redirect: 'error',
    signal: AbortSignal.any([shutdown.signal, AbortSignal.timeout(timeout)]) });

  async function poll() {
    lastCheck = now();
    const response = await request(refUrl, REF_TIMEOUT, { Accept: 'application/vnd.github+json', 'User-Agent': 'sgs-toolbox-update-mirror',
      ...(token && { Authorization: 'Bearer ' + token }), ...(etag && { 'If-None-Match': etag }) });
    if (response.status === 304 && current) return;
    const commit = JSON.parse(await readBody(response, 16384))?.object?.sha;
    if (!commitFormat.test(commit)) throw new Error('GitHub 分支引用无效');
    const nextEtag = response.headers.get('etag');
    if (current?.commit === commit) { etag = nextEtag; return; }
    const root = raw + commit + '/', files = { ...current?.files };
    const download = async (path, limit = MAX_SCRIPT) => readBody(await request(root + path, ARTIFACT_TIMEOUT), limit);
    await mkdir(objects, { recursive: true, mode: 0o700 });
    async function save(path, bytes) {
      const digest = hash(bytes);
      if (packagePath.test(path) && files[path] && files[path] !== digest) throw new Error('GitHub 插件同版本文件已改变');
      try { await writeFile(join(objects, digest), bytes, { flag: 'wx', mode: 0o600 }); }
      catch (cause) {
        if (cause.code !== 'EEXIST' || hash(await readFile(join(objects, digest))) !== digest) throw cause;
      }
      files[path] = digest;
    }

    const catalogBytes = await download('plugins/catalog.json', 2 * 1024 * 1024);
    const market = new MarketClient({ baseUrl: GITHUB_MARKET_URL, fetchImpl: async () => new Response(catalogBytes) });
    const catalog = await market.getCatalog();
    const version = catalog?.core?.version;
    if (!versionFormat.test(version) || current && compareVersions(version, current.version) < 0) throw new Error('GitHub 核心版本无效或回退');
    const packageJobs = new Set();
    let rebaseCatalog = false;
    try {
      for (const entry of catalog.plugins) {
        const packageUrl = market.resolvePackageUrl(entry.packageUrl).slice(GITHUB_MARKET_URL.length + 1);
        if (packageUrl !== `packages/${entry.id}/${entry.version}.json`) throw new Error('GitHub 插件包路径与目录不一致');
        rebaseCatalog ||= entry.packageUrl !== packageUrl;
        entry.packageUrl = packageUrl;
        const path = 'plugins/' + packageUrl;
        const job = (async () => {
          let bytes;
          if (files[path]) {
            bytes = await readFile(join(objects, files[path]));
            if (hash(bytes) !== files[path]) throw new Error('本地插件缓存校验失败');
          } else bytes = await download(path, 8 * 1024 * 1024);
          const pkg = await verifyPackage(JSON.parse(bytes));
          if (pkg.manifest.id !== entry.id || pkg.manifest.version !== entry.version || pkg.sha256.toLowerCase() !== entry.sha256.toLowerCase()
            || entry.releaseNotes !== undefined && entry.releaseNotes !== pkg.manifest.releaseNotes) {
            throw new Error('GitHub 插件包与目录摘要不一致');
          }
          await save(path, bytes);
        })();
        packageJobs.add(job);
        void job.then(() => packageJobs.delete(job), () => {});
        if (packageJobs.size >= 4) await Promise.race(packageJobs);
      }
      await Promise.all(packageJobs);
    } finally { await Promise.allSettled(packageJobs); }
    await save('plugins/catalog.json', rebaseCatalog ? Buffer.from(JSON.stringify(catalog)) : catalogBytes);
    const [meta, script] = await Promise.all([download(liteMetaPath, 16384), download(liteScriptPath)]);
    validateUserscript(meta, script, version);
    await save(liteMetaPath, meta);
    await save(liteScriptPath, script);
    const microPath = 'microclient/update.json', micro = await request(root + microPath, ARTIFACT_TIMEOUT);
    let microVersion = current?.microVersion;
    if (micro.status !== 404) {
      const manifestBytes = await readBody(micro, 16384), manifest = JSON.parse(manifestBytes);
      if (manifest.format !== 'sgs-toolbox-script-v1' || manifest.hostApi !== 1 || !versionFormat.test(manifest.version)
        || microVersion && compareVersions(manifest.version, microVersion) < 0 || !digestFormat.test(manifest.sha256)
        || !Number.isInteger(manifest.bytes) || manifest.bytes < 1 || manifest.bytes > MAX_SCRIPT) throw new Error('微端更新清单无效或回退');
      const scriptPath = 'microclient/toolbox.js', microScript = await download(scriptPath);
      if (microScript.length !== manifest.bytes || hash(microScript) !== manifest.sha256
        || !microScript.toString('utf8').startsWith('// 三国杀OL工具箱 · 微端 LITE · ' + manifest.version + '\n')) throw new Error('微端脚本版本或摘要不一致');
      new Script(microScript.toString('utf8'));
      await save(microPath, manifestBytes);
      await save(scriptPath, microScript);
      microVersion = manifest.version;
    }
    const next = { commit, version, microVersion, files, updatedAt: now() };
    await writeFile(index + '.tmp', JSON.stringify(next), { mode: 0o600 });
    await rename(index + '.tmp', index);
    current = next;
    etag = nextEtag;
  }

  const check = () => {
    if (!enabled() || shutdown.signal.aborted) return Promise.resolve();
    return inFlight ??= poll().then(() => { error = ''; }, cause => { error = cause.message; }).finally(() => { inFlight = undefined; });
  };
  if (auto) {
    timer = setInterval(() => void check(), 60000);
    void check();
  }
  return {
    check,
    status: () => ({ enabled: enabled(), version: current?.version, microVersion: current?.microVersion,
      updatedAt: current?.updatedAt, checking: Boolean(inFlight), lastCheck, error }),
    async serve(request, response) {
      const path = request.url.slice('/updates/'.length);
      const digest = (fixedPaths.has(path) || packagePath.test(path)) && current?.files[path];
      if (!enabled() || !digest) return response.writeHead(404).end();
      if (request.method !== 'GET' && request.method !== 'HEAD') return response.writeHead(405, { Allow: 'GET, HEAD' }).end();
      const bytes = await readFile(join(objects, digest));
      if (hash(bytes) !== digest) return response.writeHead(503).end();
      const immutable = packagePath.test(path);
      const tag = '"' + digest + '"';
      const headers = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'public, no-cache',
        'Content-Type': path.endsWith('.json') ? 'application/json; charset=utf-8' : 'text/javascript; charset=utf-8', ETag: tag };
      if (request.headers['if-none-match'] === tag) return response.writeHead(304, headers).end();
      response.writeHead(200, { ...headers, 'Content-Length': bytes.length }).end(request.method === 'GET' ? bytes : undefined);
    },
    async close() {
      clearInterval(timer);
      shutdown.abort();
      await inFlight;
    },
  };
}
