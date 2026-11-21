import { spawnSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
await mkdir(resolve(root, 'dist'), { recursive: true });
const result = spawnSync('tar', ['-czf', 'dist/sgs-ol-toolbox-sync-server.tar.gz',
  'server-version.json', 'package.json', 'package-lock.json', 'LICENSE', 'README.md', 'src', 'tools', 'distribution',
  'node_modules/@hpke/common', 'node_modules/@hpke/core'], { cwd: root, stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
