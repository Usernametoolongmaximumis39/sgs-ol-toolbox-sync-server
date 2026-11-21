import { validReleaseNotes } from '../shared/plugin-release-notes.js';

const PACKAGE_FORMAT = 'sgs-toolbox-plugin-v1';
const ID = /^[a-z][a-z0-9._-]{0,95}$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const DIGEST = /^[0-9a-f]{64}$/i;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

export class MarketError extends Error {
  constructor(code, message, details = {}) {
    super(message, details.cause ? { cause: details.cause } : undefined);
    this.name = 'MarketError';
    this.code = code;
    if (details.status !== undefined) this.status = details.status;
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validIdentity(value) {
  return isObject(value) && typeof value.id === 'string' && ID.test(value.id)
    && typeof value.version === 'string' && value.version.length <= 80 && VERSION.test(value.version);
}

function validEntry(entry) {
  return validIdentity(entry) && typeof entry.name === 'string' && entry.name.trim().length > 0
    && typeof entry.description === 'string' && typeof entry.packageUrl === 'string'
    && validReleaseNotes(entry.releaseNotes)
    && typeof entry.sha256 === 'string' && DIGEST.test(entry.sha256);
}

/** Only retrieves packages. The plugin manager must verify their actual cryptographic digest. */
export class MarketClient {
  constructor({ baseUrl = 'http://127.0.0.1:17321', fetchImpl = globalThis.fetch,
    timeoutMs = 10000, maxBytes = DEFAULT_MAX_BYTES } = {}) {
    let parsed;
    try { parsed = new URL(baseUrl); } catch { throw new MarketError('INVALID_URL', '插件市场地址无效。'); }
    if (!(parsed.protocol === 'https:' || (parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1'))
      || parsed.username || parsed.password || parsed.search || parsed.hash
      || /%|\\/.test(parsed.pathname)) {
      throw new MarketError('INVALID_URL', '市场地址须为 HTTPS 静态目录，或 HTTP 本机回环目录。');
    }
    if (typeof fetchImpl !== 'function') throw new MarketError('FETCH_UNAVAILABLE', '当前环境没有可用的网络请求接口。');
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isFinite(maxBytes) || maxBytes <= 0) {
      throw new MarketError('INVALID_OPTIONS', '市场超时和响应大小限制必须为正数。');
    }
    this.baseUrl = parsed.href.replace(/\/+$/, '');
    this.origin = parsed.origin;
    this.packagePath = new URL(`${this.baseUrl}/packages/`).pathname;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.maxBytes = maxBytes;
  }

  resolvePackageUrl(value) {
    let url;
    try { url = new URL(value, `${this.baseUrl}/`); } catch { throw new MarketError('INVALID_URL', '插件包下载地址无效。'); }
    if (url.origin !== this.origin || url.username || url.password || url.hash || url.search
      || !url.pathname.startsWith(this.packagePath)
      || !/^[a-z][a-z0-9._-]{0,95}\/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?\.json$/.test(url.pathname.slice(this.packagePath.length))) {
      throw new MarketError('ORIGIN_MISMATCH', '插件包必须来自当前静态市场的 packages 目录。');
    }
    return url.href;
  }

  async requestJson(url) {
    const controller = new AbortController();
    let timeout;
    const timedOut = new Promise((_, reject) => {
      timeout = setTimeout(() => {
        const error = new MarketError('TIMEOUT', '读取插件市场超时，请检查网络和托管地址。');
        reject(error);
        controller.abort(error);
      }, this.timeoutMs);
    });
    const request = (async () => {
      let response;
      try {
        response = await this.fetchImpl(url, {
          method: 'GET', credentials: 'omit', cache: 'no-store', redirect: 'error', mode: 'cors',
          ...(new URL(this.baseUrl).protocol === 'http:' ? { targetAddressSpace: 'loopback' } : {}), signal: controller.signal,
        });
      } catch (error) {
        if (controller.signal.aborted) throw controller.signal.reason;
        throw new MarketError('NETWORK_ERROR', '无法读取插件市场，请检查目录地址、网络及托管的跨域配置。', { cause: error });
      }
      if (!response || typeof response.text !== 'function') {
        throw new MarketError('INVALID_RESPONSE', '插件市场返回了无效响应。');
      }
      if (!response.ok) throw new MarketError('HTTP_ERROR', `插件市场请求失败（HTTP ${response.status}）。`, { status: response.status });
      if (response.url && response.url !== url) {
        throw new MarketError('ORIGIN_MISMATCH', '插件市场响应来自其他地址，已停止读取。');
      }
      const advertisedLength = Number(response.headers?.get('content-length'));
      if (advertisedLength > this.maxBytes) throw new MarketError('RESPONSE_TOO_LARGE', '插件市场响应超过大小限制。');
      let raw;
      try { raw = await response.text(); } catch (error) {
        if (controller.signal.aborted) throw controller.signal.reason;
        throw new MarketError('NETWORK_ERROR', '读取插件市场响应失败。', { cause: error });
      }
      if (new TextEncoder().encode(raw).byteLength > this.maxBytes) {
        throw new MarketError('RESPONSE_TOO_LARGE', '插件市场响应超过大小限制。');
      }
      try { return JSON.parse(raw); } catch (error) {
        throw new MarketError('BAD_JSON', '插件市场响应不是有效的 JSON。', { cause: error });
      }
    })();
    try { return await Promise.race([request, timedOut]); }
    finally { clearTimeout(timeout); }
  }

  async health() {
    await this.getCatalog();
    return { ok: true, service: 'sgs-toolbox-market', schemaVersion: 1 };
  }

  async getCatalog() {
    const catalog = await this.requestJson(`${this.baseUrl}/catalog.json`);
    if (!isObject(catalog) || catalog.schemaVersion !== 1 || !Array.isArray(catalog.plugins)) {
      throw new MarketError('BAD_SCHEMA', '插件目录格式不兼容。');
    }
    const seen = new Set();
    for (const entry of catalog.plugins) {
      if (!validEntry(entry)) throw new MarketError('BAD_SCHEMA', '插件目录包含无效条目。');
      const identity = `${entry.id}@${entry.version}`;
      if (seen.has(identity)) throw new MarketError('BAD_SCHEMA', '插件目录包含重复版本。');
      seen.add(identity);
      this.resolvePackageUrl(entry.packageUrl);
    }
    return catalog;
  }

  async getPackage(entry) {
    if (!validEntry(entry)) throw new MarketError('BAD_SCHEMA', '插件目录条目无效。');
    const pkg = await this.requestJson(this.resolvePackageUrl(entry.packageUrl));
    if (!isObject(pkg) || pkg.format !== PACKAGE_FORMAT || !validIdentity(pkg.manifest)
      || typeof pkg.manifest.name !== 'string' || !pkg.manifest.name.trim()
      || !validReleaseNotes(pkg.manifest.releaseNotes)
      || !Number.isInteger(pkg.manifest.apiVersion) || pkg.manifest.apiVersion < 1
      || !Array.isArray(pkg.manifest.categories) || pkg.manifest.categories.some((v) => typeof v !== 'string')
      || typeof pkg.code !== 'string' || !pkg.code.trim()
      || typeof pkg.sha256 !== 'string' || !DIGEST.test(pkg.sha256)) {
      throw new MarketError('BAD_SCHEMA', '插件包格式无效。');
    }
    if (pkg.manifest.id !== entry.id || pkg.manifest.version !== entry.version) {
      throw new MarketError('PACKAGE_ID_MISMATCH', '插件包身份或版本与目录不一致。');
    }
    if (pkg.sha256.toLowerCase() !== entry.sha256.toLowerCase()) {
      throw new MarketError('CATALOG_DIGEST_MISMATCH', '插件包摘要与目录不一致，请刷新市场目录后重试。');
    }
    if (entry.releaseNotes !== undefined && entry.releaseNotes !== pkg.manifest.releaseNotes) {
      throw new MarketError('RELEASE_NOTES_MISMATCH', '插件更新内容与目录不一致，请刷新市场目录后重试。');
    }
    return pkg;
  }
}
