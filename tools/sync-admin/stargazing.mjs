import { readStargazingJson, STARGAZING_REPORT } from '../../src/shared/stargazing-source.js';
import { SyncError } from './state.mjs';

const refreshInterval = 60_000;
const retryInterval = 15_000;
const maxAge = 6 * 60 * 60_000;
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function validReport(report) {
  return isRecord(report) && Array.isArray(report.sections) && report.sections.every(section => {
    if (!isRecord(section) || typeof section.title !== 'string' || !section.title.trim()) return false;
    if (section.kind === 'skins') return Array.isArray(section.items) && section.items.every(isRecord);
    return section.kind === 'table' && Array.isArray(section.columns) && section.columns.length > 0 && section.columns.length <= 64
      && section.columns.every(column => typeof column === 'string') && Array.isArray(section.rows) && section.rows.every(isRecord);
  });
}

export function openStargazing({ enabled, fetchImpl = fetch, now }) {
  let cached, pending, retryAt = 0;

  async function refresh() {
    try {
      const response = await fetchImpl(STARGAZING_REPORT, { redirect: 'error', credentials: 'omit', cache: 'no-store',
        headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(6000) });
      if (response.status !== 200 || response.headers.has('content-range')
          || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) {
        void response.body?.cancel().catch(() => {});
        throw new Error('Invalid report response');
      }
      const report = await readStargazingJson(response);
      if (!validReport(report)) throw new Error('Invalid report format');
      cached = { report, time: now() };
    } catch {
      retryAt = now() + retryInterval;
    }
  }

  return {
    async read() {
      if (!enabled()) throw new SyncError(409, 'stargazing_disabled');
      const time = now();
      if ((!cached || time - cached.time >= refreshInterval) && time >= retryAt) {
        pending ??= refresh().finally(() => { pending = undefined; });
        await pending;
      }
      if (!enabled()) throw new SyncError(409, 'stargazing_disabled');
      if (!cached || now() - cached.time >= maxAge) throw new SyncError(503, 'stargazing_unavailable');
      return cached.report;
    },
  };
}
