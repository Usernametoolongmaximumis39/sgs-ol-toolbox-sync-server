import { BACKUP_COOLDOWN } from '../../src/shared/sync-paths.js';
import { requireValue, token } from './state.mjs';

const pageBytes = 4 * 1024 * 1024;
const pageLifetime = 5 * 60000;

export function openBackupReads({ db, transaction }, now) {
  db.exec('CREATE TABLE IF NOT EXISTS backup_downloads (binding TEXT PRIMARY KEY, next_at INTEGER NOT NULL)');
  const get = db.prepare('SELECT next_at FROM backup_downloads WHERE binding = ?');
  const prune = db.prepare('DELETE FROM backup_downloads WHERE next_at <= ?');
  const record = db.prepare('INSERT INTO backup_downloads VALUES (?, ?)');
  const pages = new Map();
  function download(binding, take) {
    return transaction(() => {
      const time = now(), next = get.get(binding)?.next_at ?? 0;
      if (next > time) return { retryAfter: next - time };
      const reply = take();
      prune.run(time);
      record.run(binding, time + BACKUP_COOLDOWN);
      return reply;
    });
  }
  function page(binding, { downloadId, offset }, take) {
    for (const [id, lease] of pages) if (lease.expires <= now()) pages.delete(id);
    const lease = downloadId && pages.get(downloadId);
    if (downloadId !== undefined) {
      requireValue(lease && lease.binding === binding && offset === lease.offset, 'backup_page_expired', 409);
      const end = offset + pageBytes;
      lease.offset = end;
      if (end >= lease.bytes.length) pages.delete(downloadId);
      return { chunk: lease.bytes.subarray(offset, end).toString('base64'), next: end < lease.bytes.length ? end : null };
    }
    const reply = download(binding, () => {
      const reply = take();
      return { ...reply, bytes: Buffer.from(JSON.stringify(reply.snapshot)) };
    });
    if (!reply.snapshot) return reply;
    const { snapshot, cursor, bytes } = reply;
    if (bytes.length <= pageBytes) return { snapshot, cursor };
    const id = token();
    pages.set(id, { binding, bytes, offset: pageBytes, expires: now() + pageLifetime });
    return { downloadId: id, chunk: bytes.subarray(0, pageBytes).toString('base64'), next: pageBytes, cursor };
  }
  return { download, page };
}
