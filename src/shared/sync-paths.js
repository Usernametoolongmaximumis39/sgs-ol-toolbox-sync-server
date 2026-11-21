export const MATCH_SYNC_PATH = '/appearances/sync';
export const LEDGER_SYNC_PATH = '/ledger/sync';
export const PREFERENCES_SYNC_PATH = '/v1/preferences/sync';
export const PREFERENCES_RESTORED = 'sgs-toolbox:preferences-restored';
export const BACKUP_READ_PATH = '/v1/backup/read';
export const BACKUP_RESTORED = 'sgs-toolbox:backup-restored';
export const SYNC_CHANGES_PATH = '/v1/sync/changes';
export const PUBLIC_CHANGES_PATH = '/v2/vault/changes';
export const SYNC_HISTORY_UPDATED = 'sgs-toolbox:sync-history-updated';
export const BACKUP_COOLDOWN = 60 * 60000;
export const LEDGER_PREVIEW_PATH = '/ledger/';

export function validSyncCursor(cursor) {
  return /^[A-Za-z0-9_-]{43}$/.test(cursor?.epoch ?? '')
    && Number.isSafeInteger(cursor?.seq) && cursor.seq >= 0;
}
