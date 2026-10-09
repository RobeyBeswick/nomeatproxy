import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { join, resolve } from 'node:path';
import { cpus, platform, release, tmpdir } from 'node:os';
import { check } from '../dist/engine.js';

const cwd = process.cwd();
const cli = resolve('dist/cli.js');
const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];
function summarize(name, values) {
  return { name, samples: values.length, p50Ms: +percentile(values, 0.5).toFixed(3), p95Ms: +percentile(values, 0.95).toFixed(3), maxMs: +Math.max(...values).toFixed(3) };
}
const results = [];
for (const command of ['git status --short', 'rm -rf /']) {
  for (let i = 0; i < 100; i++) check({ command, cwd });
  const samples = [];
  for (let i = 0; i < 1000; i++) {
    const start = performance.now();
    check({ command, cwd });
    samples.push(performance.now() - start);
  }
  results.push(summarize(`engine: ${command}`, samples));
  const processSamples = [];
  const input = JSON.stringify({ tool_name: 'Bash', cwd, tool_input: { command } });
  for (let i = 0; i < 60; i++) {
    const start = performance.now();
    const result = spawnSync(process.execPath, [cli, 'hook', '--agent', 'claude'], { input, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr || `hook exited ${result.status}`);
    if (command.startsWith('rm') && JSON.parse(result.stdout).hookSpecificOutput.permissionDecision !== 'deny') {
      throw new Error('Benchmark did not exercise the expected denial.');
    }
    if (i >= 10) processSamples.push(performance.now() - start);
  }
  results.push(summarize(`CLI including startup: ${command}`, processSamples));
}
const native = resolve('dist/nomeatproxy-hook');
if (existsSync(native)) {
  const runtime = mkdtempSync(join(tmpdir(), 'nmp-bench-'));
  const socket = join(runtime, 'guard.sock');
  const server = spawn(process.execPath, [cli, 'serve', '--socket', socket], { stdio: ['ignore', 'ignore', 'pipe'] });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Resident checker did not become ready.')), 5000);
      server.once('error', error => { clearTimeout(timer); reject(error); });
      server.stderr.on('data', chunk => {
        if (chunk.toString().includes('checker listening')) { clearTimeout(timer); resolve(); }
      });
      server.once('exit', code => { clearTimeout(timer); reject(new Error(`Checker exited ${code}`)); });
    });
    for (const command of ['git status --short', 'rm -rf /']) {
      const samples = [];
      const input = JSON.stringify({ tool_name: 'Bash', cwd, tool_input: { command } });
      for (let i = 0; i < 60; i++) {
        const start = performance.now();
        const result = spawnSync(native, ['--agent', 'claude', '--socket', socket], { input, encoding: 'utf8' });
        if (result.status !== 0) throw new Error(result.stderr || `native hook exited ${result.status}`);
        if (command.startsWith('rm')) {
          if (JSON.parse(result.stdout).hookSpecificOutput.permissionDecision !== 'deny') throw new Error('Expected denial.');
        } else if (result.stdout || result.stderr) throw new Error('Ordinary request failed or was blocked.');
        if (i >= 10) samples.push(performance.now() - start);
      }
      results.push(summarize(`native startup + resident round trip: ${command}`, samples));
    }
  } finally {
    server.kill('SIGTERM');
    await new Promise(resolve => server.once('close', resolve));
    rmSync(runtime, { recursive: true, force: true });
  }
}
const fixture = mkdtempSync(join(tmpdir(), 'nomeatproxy-bench-'));
try {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  for (const args of [['init', '--template='], ['add', '.'], ['commit', '-m', 'Benchmark fixture']]) {
    if (args[0] === 'add') writeFileSync(join(fixture, 'tracked.txt'), 'committed\n');
    const setup = spawnSync('git', [
      '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false',
      '-c', 'user.name=NoMeatProxy Benchmark', '-c', 'user.email=nomeatproxy@example.invalid',
      ...args,
    ], {
      cwd: fixture,
      env: { ...env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
      encoding: 'utf8',
    });
    if (setup.status !== 0) throw new Error(setup.stderr);
  }
  const samples = [];
  for (let i = 0; i < 25; i++) {
    const start = performance.now();
    const result = check({ command: 'git reset --hard HEAD', cwd: fixture });
    if (result.decision !== 'pass') throw new Error(JSON.stringify(result));
    if (i >= 5) samples.push(performance.now() - start);
  }
  results.push(summarize('engine with real Git probe: clean-tree reset inspection', samples));
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
console.log(JSON.stringify({
  date: new Date().toISOString(),
  machine: { node: process.version, platform: `${platform()} ${release()}`, cpu: cpus()[0]?.model },
  scope: 'Warm filesystem, fresh client processes, resident round trips when the optional launcher is built, and one small local Git fixture. No agent framework or remote services. Inspected fixture commands are never executed.',
  results,
}, null, 2));
