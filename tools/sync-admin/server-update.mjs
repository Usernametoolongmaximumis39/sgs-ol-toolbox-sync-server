import { randomUUID } from 'node:crypto';
import { access, link, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { requireValue } from './state.mjs';

export function openServerUpdate(directory) {
  const versionFile = new URL('../../server-version.json', import.meta.url);
  const current = readFile(versionFile, 'utf8').then(text => JSON.parse(text).version).catch(() => null);
  const requestFile = directory && join(directory, 'requests', 'update.json');
  const exists = filename => access(filename).then(() => true, () => false);
  async function status() {
    const version = await current;
    if (!directory) return { current: version, configured: false };
    const [progress, pending] = await Promise.all([
      readFile(join(directory, 'status.json'), 'utf8').then(JSON.parse).catch(() => ({})),
      exists(requestFile),
    ]);
    return { ...progress, current: version, configured: true, pending };
  }
  return {
    status,
    async request(action, version) {
      requireValue(directory, 'server_update_unavailable', 409);
      const progress = await status();
      requireValue(!progress.pending && !['checking', 'installing'].includes(progress.phase), 'server_update_busy', 409);
      requireValue(action === 'check' || action === 'install' && progress.phase === 'available' && version === progress.latest,
        'server_update_version_changed', 409);
      const temporary = join(directory, 'requests', randomUUID() + '.tmp');
      await writeFile(temporary, JSON.stringify({ action, version }), { flag: 'wx', mode: 0o600 });
      try { await link(temporary, requestFile); }
      catch (error) {
        if (error.code === 'EEXIST') requireValue(false, 'server_update_busy', 409);
        throw error;
      } finally { await unlink(temporary); }
    },
  };
}
