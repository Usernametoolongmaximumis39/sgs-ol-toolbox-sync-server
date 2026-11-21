import { validSyncCursor } from '../../src/shared/sync-paths.js';
import { requireValue, token } from './state.mjs';

const pageSize = 128;
const pageBytes = 1024 * 1024;

export function openSyncChanges({ db }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_change_heads (
      stream TEXT PRIMARY KEY, epoch TEXT NOT NULL, seq INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sync_change_records (
      stream TEXT NOT NULL REFERENCES sync_change_heads(stream) ON DELETE CASCADE,
      kind TEXT NOT NULL, id TEXT NOT NULL, seq INTEGER NOT NULL, payload TEXT,
      PRIMARY KEY (stream, kind, id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS sync_change_order ON sync_change_records (stream, seq);
  `);
  const head = db.prepare('SELECT epoch, seq FROM sync_change_heads WHERE stream = ?');
  const create = db.prepare('INSERT INTO sync_change_heads VALUES (?, ?, 0)');
  const update = db.prepare('UPDATE sync_change_heads SET seq = ? WHERE stream = ?');
  const write = db.prepare(`INSERT INTO sync_change_records VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (stream, kind, id) DO UPDATE SET seq = excluded.seq, payload = excluded.payload`);
  const page = db.prepare(`SELECT kind, id, seq, payload FROM sync_change_records
    WHERE stream = ? AND seq > ? ORDER BY seq LIMIT ?`);
  const stored = db.prepare(`SELECT stream, kind, id, payload FROM sync_change_records
    WHERE stream GLOB 'private:*' AND kind <> 'preferences' AND payload IS NOT NULL ORDER BY rowid`);
  const removeRecords = db.prepare('DELETE FROM sync_change_records WHERE stream GLOB ?');
  const removeHeads = db.prepare('DELETE FROM sync_change_heads WHERE stream GLOB ?');

  function cursor(stream) {
    const known = head.get(stream);
    if (known) return known;
    const epoch = token();
    create.run(stream, epoch);
    return { epoch, seq: 0 };
  }
  return {
    cursor,
    // Call within the transaction that commits the write. Public rows store a reference
    // to their ciphertext row, while private rows carry the current value here.
    record(stream, records) {
      if (!records.length) return;
      let { seq } = cursor(stream);
      for (const [kind, id, value] of records) write.run(stream, kind, id, ++seq, value === null ? null : JSON.stringify(value));
      update.run(seq, stream);
    },
    read(stream, after, resolve = (_kind, _id, value) => value) {
      requireValue(validSyncCursor(after), 'invalid_sync_cursor');
      const current = cursor(stream);
      if (after.epoch !== current.epoch || after.seq > current.seq) return { reset: true };
      const records = [];
      let bytes = 0, seq = after.seq;
      for (const row of page.iterate(stream, after.seq, pageSize + 1)) {
        if (records.length === pageSize) break;
        const record = [row.kind, row.id, row.payload === null ? null : resolve(row.kind, row.id, JSON.parse(row.payload))];
        const size = Buffer.byteLength(JSON.stringify(record)) + 1;
        if (records.length && bytes + size > pageBytes) break;
        records.push(record);
        seq = row.seq;
        bytes += size;
      }
      return { records, cursor: { epoch: current.epoch, seq }, more: seq < current.seq };
    },
    privateRows: () => stored.all().map(({ stream, kind, id, payload }) => [stream.slice('private:'.length), [kind, id, JSON.parse(payload)]]),
    reset(stream) {
      removeRecords.run(stream);
      removeHeads.run(stream);
    },
  };
}
