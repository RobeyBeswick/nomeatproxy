import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { AGENTS, configPath, configure, hookHandler, installationStatus } from '../dist/setup.js';

const root = mkdtempSync(join(tmpdir(), "nmp setup ü's "));
after(() => rmSync(root, { recursive: true, force: true }));
let sequence = 0;
function scope() {
  const cwd = join(root, String(sequence++));
  mkdirSync(cwd);
  return { cwd, home: cwd, env: {}, project: true };
}
function put(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
}
const parse = path => JSON.parse(readFileSync(path, 'utf8'));
const other = { matcher: 'Bash', hooks: [{ type: 'command', command: 'some-other-tool inspect' }] };

test('agent paths distinguish global/project scopes and respect config directories', () => {
  const options = { ...scope(), project: false };
  assert.equal(configPath('claude', options), join(options.home, '.claude', 'settings.json'));
  assert.equal(configPath('codex', options), join(options.home, '.codex', 'hooks.json'));
  assert.equal(configPath('antigravity', options), join(options.home, '.gemini', 'config', 'hooks.json'));
  assert.equal(configPath('opencode', options), join(options.home, '.config', 'opencode', 'plugins', 'nomeatproxy.js'));
  const env = { CODEX_HOME: join(root, 'custom-codex'), CLAUDE_CONFIG_DIR: join(root, 'custom-claude'), XDG_CONFIG_HOME: join(root, 'xdg') };
  assert.equal(configPath('codex', { ...options, env }), join(env.CODEX_HOME, 'hooks.json'));
  assert.equal(configPath('claude', { ...options, env }), join(env.CLAUDE_CONFIG_DIR, 'settings.json'));
  assert.equal(configPath('opencode', { ...options, env }), join(env.XDG_CONFIG_HOME, 'opencode', 'plugins', 'nomeatproxy.js'));
  assert.equal(configPath('codex', { ...options, env, project: true }), join(options.cwd, '.codex', 'hooks.json'));
});

for (const agent of AGENTS) {
  test(`${agent}: install, repeat install, diagnose, and uninstall in an isolated project`, async () => {
    const options = scope();
    const first = configure(agent, false, options);
    assert.equal(first.changed, true);
    assert.equal(first.backup, undefined);
    const text = readFileSync(first.path, 'utf8');
    if (agent === 'opencode') {
      const { pathToFileURL } = await import('node:url');
      const { NoMeatProxyPlugin } = await import(pathToFileURL(first.path).href);
      const plugin = await NoMeatProxyPlugin({ directory: options.cwd });
      await assert.rejects(plugin['tool.execute.before']({ tool: 'bash' }, { args: { command: 'rm -rf /' } }));
    }
    assert.equal(configure(agent, false, options).changed, false);
    assert.equal(readFileSync(first.path, 'utf8'), text);
    assert.equal(installationStatus(agent, options).installed, true);
    const removed = configure(agent, true, options);
    assert.equal(removed.changed, true);
    assert.equal(readFileSync(removed.backup, 'utf8'), text);
    assert.equal(installationStatus(agent, options).installed, false);
    assert.equal(configure(agent, true, options).changed, false);
  });
}

for (const agent of ['claude', 'codex', 'antigravity']) {
  test(`${agent}: preserves unrelated settings and makes recoverable, unique backups`, () => {
    const options = scope();
    const initial = agent === 'antigravity'
      ? { otherGuard: { PreToolUse: [other] } }
      : { permissions: { allow: ['Read'] }, hooks: { Stop: [other], PreToolUse: [other] } };
    const path = configPath(agent, options);
    put(path, initial);
    const before = readFileSync(path, 'utf8');
    const installed = configure(agent, false, options);
    assert.equal(readFileSync(installed.backup, 'utf8'), before);
    const repeated = configure(agent, false, options);
    assert.equal(repeated.changed, false);
    const removed = configure(agent, true, options);
    assert.notEqual(installed.backup, removed.backup);
    assert.deepEqual(parse(path), initial);
  });
}

test('removing a managed handler preserves other handlers in the same group', () => {
  const options = scope();
  const { path } = configure('claude', false, options);
  const settings = parse(path);
  settings.hooks.PreToolUse[0].hooks.push(other.hooks[0]);
  put(path, settings);
  configure('claude', true, options);
  assert.deepEqual(parse(path).hooks.PreToolUse, [other]);
});

test('invalid JSON and malformed hook structures are never overwritten or backed up', () => {
  for (const text of ['{broken', '[]', '{"hooks":null}', '{"hooks":{"PreToolUse":{}}}', '{"hooks":{"PreToolUse":[{}]}}']) {
    const options = scope();
    const path = configPath('claude', options);
    put(path, text);
    assert.throws(() => configure('claude', false, options));
    assert.equal(readFileSync(path, 'utf8'), text);
    assert.deepEqual(readdirSync(dirname(path)), ['settings.json']);
  }
});

test('unmanaged plugin and named Antigravity hook collisions are left intact', () => {
  for (const agent of ['opencode', 'antigravity']) {
    const options = scope();
    const path = configPath(agent, options);
    const text = agent === 'opencode' ? '// my plugin\n' : '{"nomeatproxy":{"PreToolUse":[]}}';
    put(path, text);
    assert.throws(() => configure(agent, false, options), /unmanaged/);
    assert.equal(readFileSync(path, 'utf8'), text);
  }
});

test('a settings directory is never replaced', () => {
  const options = scope();
  const path = configPath('codex', options);
  mkdirSync(path, { recursive: true });
  assert.throws(() => configure('codex', false, options), /regular file/);
});

test('a settings symlink is never replaced or followed', { skip: process.platform === 'win32' }, () => {
  const options = scope();
  const path = configPath('claude', options);
  const target = join(options.cwd, 'keep.json');
  put(target, '{}');
  mkdirSync(dirname(path));
  symlinkSync(target, path);
  assert.throws(() => configure('claude', false, options), /regular file/);
  assert.equal(readFileSync(target, 'utf8'), '{}');
});

test('doctor detects moved installations and disabled hooks; reinstall updates paths', () => {
  const options = scope();
  const { path } = configure('codex', false, options);
  const settings = parse(path);
  settings.hooks.PreToolUse[0].hooks[0] = hookHandler('codex', { managed: true, cli: join(root, 'old', 'cli.js') });
  put(path, settings);
  assert.equal(installationStatus('codex', options).installed, false);
  assert.equal(configure('codex', false, options).changed, true);
  assert.equal(installationStatus('codex', options).installed, true);
  const current = parse(path);
  current.disableAllHooks = true;
  put(path, current);
  assert.equal(installationStatus('codex', options).installed, false);
});

function invoke(handler, input, shell) {
  const args = handler.args ?? [];
  const executable = handler.command;
  const result = shell === 'powershell'
    ? spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', executable], { input, encoding: 'utf8', timeout: 10_000 })
    : spawnSync(executable, args, { shell: handler.args ? false : true, input, encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.status, 0, `${result.error ?? ''} ${result.stderr}`);
  return result.stdout;
}

test('generated hooks handle stdin and workspace names with spaces, apostrophes, and Unicode', () => {
  for (const agent of ['claude', 'codex', 'antigravity']) {
    const options = scope();
    const handler = hookHandler(agent, { workspace: options.cwd, managed: true });
    const input = command => JSON.stringify(agent === 'antigravity'
      ? { toolCall: { name: 'run_command', args: { CommandLine: command, Cwd: options.cwd } }, workspacePaths: [options.cwd] }
      : { tool_name: 'Bash', tool_input: { command }, cwd: options.cwd });
    assert.equal(invoke(handler, input('git status')), '');
    const denied = JSON.parse(invoke(handler, input('rm -rf /')));
    assert.equal(agent === 'antigravity' ? denied.decision : denied.hookSpecificOutput.permissionDecision, 'deny');
    assert.equal(existsSync(options.cwd), true);
    if (process.platform === 'win32' && agent !== 'claude') {
      assert.equal(invoke(handler, input('git status'), 'powershell'), '');
      assert.match(invoke(handler, input('rm -rf /'), 'powershell'), /deny/);
    }
  }
});

test('Windows shell bootstrap executes the same checker without an extra process', () => {
  const options = scope();
  const handler = hookHandler('codex', { platform: 'win32', workspace: options.cwd, managed: true });
  const input = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'rm -rf /' }, cwd: options.cwd });
  assert.equal(JSON.parse(invoke(handler, input)).hookSpecificOutput.permissionDecision, 'deny');
});
