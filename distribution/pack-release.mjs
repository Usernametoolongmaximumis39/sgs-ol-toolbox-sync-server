import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const dist = resolve(root, 'dist');
await mkdir(dist, { recursive: true });
const bundle = 'sgs-ol-toolbox-sync-server.tar.gz';
const archive = resolve(dist, bundle);
const result = spawnSync('tar', ['-czf', archive,
  'server-version.json', 'package.json', 'package-lock.json', 'LICENSE', 'README.md', 'AGENTS.md', 'llms.txt', 'src', 'tools', 'distribution',
  'node_modules/@hpke/common', 'node_modules/@hpke/core'], { cwd: root, stdio: 'inherit' });
if (result.error) throw result.error;
if (result.status !== 0) throw new Error('Server archive creation failed');
const sha256 = createHash('sha256').update(await readFile(archive)).digest('hex');
await writeFile(archive + '.sha256', `${sha256}  ${bundle}\n`);
for (const installer of ['install-linux.sh', 'install-windows.ps1']) {
  await copyFile(resolve(root, 'distribution', installer), resolve(dist, installer));
}
