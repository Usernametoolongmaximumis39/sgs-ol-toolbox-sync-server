import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { packageDigest, verifyPackage } from '../src/core/packages.js';
import { openUpdateMirror } from '../tools/sync-admin/update-mirror.mjs';

test('mirror accepts plugins for newer cores and retains verified downloads after a failed update and restart', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'update-mirror-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const manifest = { id: 'example', name: '示例', version: '1.0.0', apiVersion: 1, categories: [], minCoreVersion: '999.0.0' };
  const code = 'return {};', sha256 = await packageDigest(manifest, code);
  const pkg = { format: 'sgs-toolbox-plugin-v1', manifest, code, sha256 };
  const entry = { ...manifest, description: '示例', packageUrl: 'packages/example/1.0.0.json', sha256 };
  const cachedVersion = manifest.minCoreVersion;
  let commit = 'a'.repeat(40), version = cachedVersion, enabled = true, badHash = false, brokenCore = false;
  let packageDownloads = 0, conditional = false, rawUnavailable = false;
  const rawFailures = [], contentsDownloads = [];
  const files = () => {
    const script = '// 三国杀OL工具箱 · 微端 LITE · ' + version + '\nvoid 0;\n';
    const files = {
      'plugins/catalog.json': JSON.stringify({ schemaVersion: 1, core: { version }, plugins: [badHash ? { ...entry, sha256: '0'.repeat(64) } : entry] }),
      ['plugins/' + entry.packageUrl]: JSON.stringify(pkg),
      'microclient/toolbox.js': script,
      'microclient/update.json': JSON.stringify({ format: 'sgs-toolbox-script-v1', hostApi: 1, version,
        sha256: createHash('sha256').update(script).digest('hex'), bytes: Buffer.byteLength(script) }),
    };
    const header = '// ==UserScript==\n// @namespace sgs-ol-toolbox\n// @version ' + version + '\n// ==/UserScript==\n';
    files['lite/toolbox.meta.js'] = header;
    files['lite/toolbox.user.js'] = header + (brokenCore ? 'const !' : 'void 0;');
    return files;
  };
  const fetchImpl = async (url, { headers }) => {
    if (url.startsWith('https://api.github.com/') && url.endsWith('/git/ref/heads/main')) {
      assert.equal(headers.Authorization, 'Bearer read-token');
      if (headers['If-None-Match'] === commit) {
        conditional = true;
        return new Response(null, { status: 304 });
      }
      return Response.json({ object: { sha: commit } }, { headers: { ETag: commit } });
    }
    const address = new URL(url);
    let path;
    if (address.origin === 'https://api.github.com') {
      assert.equal(headers.Authorization, 'Bearer read-token');
      assert.equal(headers.Accept, 'application/vnd.github.raw+json');
      assert.equal(address.searchParams.get('ref'), commit);
      path = address.pathname.split('/contents/')[1];
      contentsDownloads.push(path);
    } else {
      assert.equal(address.origin, 'https://raw.githubusercontent.com');
      assert.equal(headers, undefined);
      assert.ok(url.includes('/' + commit + '/'));
      path = address.pathname.split('/' + commit + '/')[1];
      if (rawUnavailable) {
        rawFailures.push(path);
        return new Response(new ReadableStream({ start(controller) { controller.error(new Error('connection dropped')); } }));
      }
    }
    assert.ok(!path.startsWith('full/'));
    if (path === 'plugins/' + entry.packageUrl) packageDownloads++;
    return new Response(files()[path], { status: Object.hasOwn(files(), path) ? 200 : 404 });
  };
  const options = { dataDir, enabled: () => enabled, fetchImpl, token: 'read-token' };
  let mirror = await openUpdateMirror(options);
  async function request(url, { method = 'GET', headers = {} } = {}) {
    const result = {};
    await mirror.serve({ url, headers, method }, {
      writeHead(status, headers) { Object.assign(result, { status, headers }); return this; },
      end(body) { result.body = body; },
    });
    return result;
  }
  try {
    await assert.rejects(verifyPackage(pkg), /插件需要核心 999\.0\.0/);
    await mirror.check();
    assert.equal(mirror.status().version, version, mirror.status().error);
    assert.equal(mirror.status().microVersion, version);
    assert.equal(packageDownloads, 1);
    await mirror.check();
    assert.equal(conditional, true);
    const path = '/updates/plugins/' + entry.packageUrl;
    const first = await request(path);
    assert.equal(first.status, 200);
    assert.deepEqual(JSON.parse(first.body), pkg);
    assert.equal((await request(path, { method: 'HEAD', headers: { 'if-none-match': first.headers.ETag } })).status, 304);
    assert.equal((await request('/updates/../admin-token')).status, 404);
    assert.equal((await request('/updates/lite/toolbox.user.js')).status, 200);
    assert.equal((await request(path, { method: 'POST' })).status, 405);

    commit = 'b'.repeat(40);
    version = '999.0.1';
    badHash = true;
    await mirror.check();
    assert.match(mirror.status().error, /摘要/);
    assert.equal(mirror.status().version, cachedVersion);
    badHash = false;
    brokenCore = true;
    await mirror.check();
    assert.match(mirror.status().error, /token/);
    assert.equal(JSON.parse((await request('/updates/plugins/catalog.json')).body).core.version, cachedVersion);

    await mirror.close();
    const indexPath = join(dataDir, 'updates', 'current.json');
    const index = JSON.parse(await readFile(indexPath, 'utf8'));
    index.files['full/toolbox.user.js'] = index.files['lite/toolbox.user.js'];
    await writeFile(indexPath, JSON.stringify(index));
    mirror = await openUpdateMirror(options);
    assert.equal(mirror.status().version, cachedVersion);
    assert.equal((await request(path)).status, 200);
    assert.equal((await request('/updates/full/toolbox.user.js')).status, 404);
    brokenCore = false;
    rawUnavailable = true;
    await mirror.check();
    assert.equal(mirror.status().version, version, mirror.status().error);
    assert.equal(packageDownloads, 1);
    assert.deepEqual(rawFailures, ['plugins/catalog.json']);
    assert.deepEqual(contentsDownloads, ['plugins/catalog.json', 'lite/toolbox.meta.js', 'lite/toolbox.user.js',
      'microclient/update.json', 'microclient/toolbox.js']);

    enabled = false;
    assert.equal((await request(path)).status, 404);
  } finally { await mirror.close(); }
});
