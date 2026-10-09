import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, chmodSync, existsSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { createServer, createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { serve, dispatch } from '../dist/server.js';
import { runHook } from '../dist/adapters/hook.js';

const root = mkdtempSync(join(tmpdir(), 'nmp-runtime-'));
const native = resolve('dist/nomeatproxy-hook');
const hasNative = existsSync(native);
after(() => rmSync(root, { recursive: true, force: true }));
const close = server => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
let serial = 0;
function socketPath() {
  const dir = join(root, `case-${serial++}`);
  mkdirSync(dir, { mode: 0o700 });
  return join(dir, 'guard.sock');
}
function run(socket, input, agent = 'claude', extra = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(native, ['--agent', agent, '--socket', socket, ...extra], {
      cwd: root, stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000,
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ exitCode: code, stdout, stderr }));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}
const payload = command => JSON.stringify({ tool_name: 'Bash', cwd: root, tool_input: { command } });

test('resident dispatcher rejects unknown protocol and missing fields', () => {
  assert.throws(() => dispatch({ version: 0 }));
  assert.throws(() => dispatch({ version: 1, agent: 'claude', cwd: 'relative', input: '{}' }));
  assert.equal(dispatch({ version: 1, agent: 'claude', cwd: root, input: payload('ls') }).result.stdout, '');
});

test('server refuses public directories and existing files without replacing them', async () => {
  const dir = join(root, 'public');
  mkdirSync(dir, { mode: 0o755 });
  await assert.rejects(serve(join(dir, 'guard.sock')), /0700/);
  const path = socketPath();
  writeFileSync(path, 'keep me');
  await assert.rejects(serve(path), /already exists/);
  assert.equal(readFileSync(path, 'utf8'), 'keep me');
});

test('native and direct hook paths make identical decisions', { skip: !hasNative }, async () => {
  const path = socketPath();
  const server = await serve(path);
  try {
    for (const agent of ['claude', 'codex', 'generic']) {
      for (const command of ['git status', 'rm -rf /', 'git push --force origin main']) {
        const input = payload(command);
        assert.deepEqual(await run(path, input, agent), runHook(input, agent, root));
      }
    }
    const anti = JSON.stringify({
      toolCall: { name: 'run_command', args: { CommandLine: 'rm -rf /', Cwd: root } },
      workspacePaths: [root],
    });
    assert.deepEqual(await run(path, anti, 'antigravity'), runHook(anti, 'antigravity', root));
  } finally { await close(server); }
});

test('resident checker reads current filesystem facts and does not cache a pass', { skip: !hasNative }, async () => {
  const path = socketPath();
  const server = await serve(path);
  try {
    const name = 'not-present-then-valuable.txt';
    const input = payload(`rm -f ${name}`);
    assert.equal((await run(path, input)).stdout, '');
    writeFileSync(join(root, name), 'valuable new work');
    assert.equal(JSON.parse((await run(path, input)).stdout).hookSpecificOutput.permissionDecision, 'deny');
    assert.equal(existsSync(join(root, name)), true);
  } finally { await close(server); }
});

test('native client blocks on unavailable service for every output contract', { skip: !hasNative }, async () => {
  const path = socketPath();
  assert.equal(JSON.parse((await run(path, payload('ls'))).stdout).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(JSON.parse((await run(path, '{}', 'antigravity')).stdout).decision, 'deny');
  assert.equal((await run(path, payload('ls'), 'generic')).exitCode, 2);
});

test('native client blocks on stalled service and malformed or incomplete replies', { skip: !hasNative }, async () => {
  for (const response of [
    null, '{bad}\n', '{"version":1,"result":{}}\n',
    '{"version":1,"result":{"exitCode":0,"stdout":"not hook JSON","stderr":""}}\n',
    '{"version":1,"result":{"exitCode":0,"stdout":"{\\"decision\\":\\"allow\\"}","stderr":""}}\n',
  ]) {
    const path = socketPath();
    const clients = new Set();
    const server = createServer(client => {
      clients.add(client);
      client.on('close', () => clients.delete(client));
      client.on('error', () => {});
      client.on('data', () => { if (response) client.end(response); });
    });
    await new Promise(resolve => server.listen(path, resolve));
    chmodSync(path, 0o600);
    try {
      const result = await run(path, payload('ls'), 'claude', ['--timeout-ms', '50']);
      assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, 'deny');
    } finally {
      for (const client of clients) client.destroy();
      await close(server);
    }
  }
});

test('oversized and malformed requests cannot crash the resident checker', { skip: !hasNative }, async () => {
  const path = socketPath();
  const server = await serve(path);
  try {
    const bad = await run(path, 'x'.repeat(128 * 1024 + 1));
    assert.equal(JSON.parse(bad.stdout).hookSpecificOutput.permissionDecision, 'deny');
    assert.equal(JSON.parse((await run(path, '{invalid')).stdout).hookSpecificOutput.permissionDecision, 'deny');
    const reply = await new Promise((resolve, reject) => {
      const client = createConnection(path);
      let data = '';
      client.on('connect', () => client.end(JSON.stringify({ version: 999 }) + '\n'));
      client.on('data', chunk => { data += chunk; });
      client.on('error', reject);
      client.on('end', () => resolve(JSON.parse(data)));
    });
    assert.ok(reply.error);
    assert.equal((await run(path, payload('git status'))).stdout, '');
  } finally { await close(server); }
});

test('concurrent ordinary requests each receive one independent response', { skip: !hasNative }, async () => {
  const path = socketPath();
  const server = await serve(path);
  try {
    const results = await Promise.all(Array.from({ length: 10 }, () => run(path, payload('git status'))));
    for (const result of results) assert.deepEqual(result, { exitCode: 0, stdout: '', stderr: '' });
  } finally { await close(server); }
});
