import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

if (process.platform === 'win32') throw new Error('The native Unix socket client currently supports POSIX hosts only.');
mkdirSync('dist', { recursive: true });
const result = spawnSync('go', ['build', '-trimpath', '-ldflags=-s -w', '-o', 'dist/nomeatproxy-hook', './cmd/nomeatproxy-hook'], {
  stdio: 'inherit',
  env: { ...process.env, CGO_ENABLED: '0', GOTOOLCHAIN: 'local' },
});
if (result.error) throw new Error(`Building the optional native launcher requires Go 1.22+: ${result.error.message}`);
process.exitCode = result.status ?? 1;
