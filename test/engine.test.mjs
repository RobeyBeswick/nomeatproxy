import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir, devNull } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { check } from '../dist/engine.js';
import { runHook } from '../dist/adapters/hook.js';
import { NoMeatProxyPlugin } from '../dist/adapters/opencode.js';

const root = mkdtempSync(join(tmpdir(), 'nomeatproxy-tests-'));
const workspace = join(root, 'workspace');
const home = join(root, 'home');
mkdirSync(workspace);
mkdirSync(home);
after(() => rmSync(root, { recursive: true, force: true }));
const request = command => ({ command, cwd: workspace, workspace, home });
const rules = result => result.findings.map(f => f.rule);

for (const command of [
  'rm -rf /', 'rm -rf .', 'rm -rf ..', 'rm -r -- /', '/bin/rm -Rf /',
  'sudo -u root rm -rf /', 'command rm -rf /', "bash -lc 'rm -rf /'",
  'printf "%s" "$(rm -rf /)"', "echo 'ok'; rm -rf /",
  'env FOO=bar /bin/rm -rf /', 'cd missing && rm -rf /',
]) {
  test(`blocks ${command}`, () => assert.equal(check(request(command)).decision, 'deny'));
}

for (const command of [
  'git status --short', 'git diff --stat', 'rg TODO src', 'ls -la',
  "printf '%s' 'rm -rf /'", 'echo "rm -rf /"', 'command -v rm',
  'git push origin feature', 'git push --dry-run --force origin main', 'git clean -nd', 'rm --help',
  'rm -f definitely-not-present',
]) {
  test(`does not interrupt ${command}`, () => {
    const result = check(request(command), { inspectGit: () => { throw new Error('Unexpected subprocess'); } });
    assert.equal(result.decision, 'pass', JSON.stringify(result));
  });
}

for (const command of ['rm -rf "$TARGET"', 'rm -rf *', 'rm -rf ~/Documents', 'rm -rf build/{one,two}']) {
  test(`holds unresolved deletion ${command}`, () => {
    assert.ok(rules(check(request(command))).includes('filesystem.unknown-target'));
  });
}

test('resolves symlink escapes without following a submitted command', () => {
  const outside = join(root, 'outside');
  mkdirSync(outside);
  symlinkSync(outside, join(workspace, 'link'), 'junction');
  assert.ok(rules(check(request('rm -rf link/child'))).includes('filesystem.outside-workspace'));
});

test('protects repository metadata and configured sensitive paths', () => {
  assert.ok(rules(check(request('rm -rf .git'))).includes('filesystem.protected-path'));
  const result = check({ ...request('rm -rf data'), protectedPaths: ['data'] });
  assert.ok(rules(result).includes('filesystem.protected-path'));
});

test('workspace remains fixed when the command changes directory', () => {
  assert.equal(check(request('cd .. && rm -rf workspace')).decision, 'deny');
  assert.equal(check(request('cd cache; rm -rf child')).decision, 'deny');
  assert.equal(check(request('false && cd cache; rm -rf .')).decision, 'deny');
});

test('literal quotes do not turn asterisk filenames into wildcards', () => {
  const result = check(request("rm -f 'literal*file'"));
  assert.equal(result.decision, 'pass');
});

for (const command of [
  'git push --force origin main', 'git push --force-with-lease origin main',
  'git push origin +main:main', 'git push --delete origin main', 'git push --mirror origin',
  'git push origin :main',
]) {
  test(`holds remote history mutation ${command}`, () =>
    assert.ok(rules(check(request(command))).includes('git.remote-history')));
}

test('checker never executes the submitted command', () => {
  const marker = join(workspace, 'MUST-NOT-EXIST');
  check(request(`touch '${marker}' && rm -rf /`));
  assert.equal(existsSync(marker), false);
});

test('unsupported programs pass with an explicit coverage gap', () => {
  const result = check(request('python cleanup.py'));
  assert.equal(result.decision, 'pass');
  assert.match(result.limitations.join(' '), /not inspected/);
});

test('malformed and oversized commands stop inspection', () => {
  assert.equal(check(request("rm 'unterminated")).decision, 'deny');
  assert.equal(check(request('x'.repeat(65_537))).decision, 'deny');
  assert.equal(check({ command: 'ls', cwd: 'relative' }).decision, 'deny');
});

function git(cwd, ...args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  const result = spawnSync('git', [
    '-c', `core.hooksPath=${devNull}`,
    '-c', 'core.autocrlf=false',
    '-c', 'commit.gpgsign=false',
    '-c', 'user.name=NoMeatProxy Test',
    '-c', 'user.email=nomeatproxy@example.invalid',
    ...args,
  ], { cwd, env: { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: devNull }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function repository(name) {
  const cwd = join(root, name);
  mkdirSync(cwd);
  git(cwd, 'init', '--template=');
  writeFileSync(join(cwd, 'tracked.txt'), 'committed\n');
  writeFileSync(join(cwd, '.gitignore'), 'ignored/\n');
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-m', 'Fixture');
  return cwd;
}

test('actual Git: protects modified and untracked work but allows clean tracked deletion', () => {
  const cwd = repository('git-files');
  const run = command => check({ command, cwd, home });
  assert.equal(run('rm tracked.txt').decision, 'pass');
  writeFileSync(join(cwd, 'tracked.txt'), 'valuable edits\n');
  assert.ok(rules(run('rm tracked.txt')).includes('filesystem.uncommitted-work'));
  writeFileSync(join(cwd, 'untracked.txt'), 'valuable new work\n');
  assert.equal(run('rm untracked.txt').decision, 'deny');
  assert.equal(readFileSync(join(cwd, 'tracked.txt'), 'utf8'), 'valuable edits\n');
});

test('actual Git: does not treat ignored data as disposable', () => {
  const cwd = repository('git-ignored');
  mkdirSync(join(cwd, 'ignored'));
  writeFileSync(join(cwd, 'ignored', 'database.db'), 'irreplaceable\n');
  const result = check({ command: 'rm -rf ignored', cwd, home });
  assert.equal(result.decision, 'deny');
  assert.match(result.findings[0].evidence.join(' '), /database.db/);
});

test('actual Git: hard reset passes for a clean tree and stops for local work', () => {
  const cwd = repository('git-reset');
  assert.equal(check({ command: 'git reset --hard HEAD', cwd }).decision, 'pass');
  writeFileSync(join(cwd, 'tracked.txt'), 'valuable edits\n');
  assert.equal(check({ command: 'git reset --hard HEAD', cwd }).decision, 'deny');
  assert.equal(check({ command: `git -C '${cwd}' reset --hard`, cwd: root }).decision, 'deny');
  assert.equal(check({ command: 'git restore tracked.txt', cwd }).decision, 'deny');
});

test('actual Git: restoring a clean path ignores unrelated modified and untracked work', () => {
  const cwd = repository('git-restore-scoped');
  writeFileSync(join(cwd, '.gitignore'), 'different local edits\n');
  writeFileSync(join(cwd, 'unrelated.txt'), 'new work\n');
  for (const command of [
    'git restore tracked.txt', 'git restore --worktree -- tracked.txt',
    'git checkout -- tracked.txt', 'git restore --source HEAD tracked.txt',
    'git checkout HEAD -- tracked.txt',
  ]) {
    const result = check({ command, cwd });
    assert.equal(result.decision, 'pass', `${command}: ${JSON.stringify(result)}`);
  }
});

test('actual Git: worktree restore preserves identical staged content', () => {
  const cwd = repository('git-restore-staged');
  writeFileSync(join(cwd, 'tracked.txt'), 'staged version\n');
  git(cwd, 'add', 'tracked.txt');
  assert.equal(check({ command: 'git restore tracked.txt', cwd }).decision, 'pass');
  assert.equal(check({ command: 'git checkout -- tracked.txt', cwd }).decision, 'pass');
  assert.equal(check({ command: 'git restore --staged tracked.txt', cwd }).decision, 'pass');
  assert.equal(check({ command: 'git restore -S tracked.txt', cwd }).decision, 'pass');
  assert.equal(check({ command: 'git restore -SW tracked.txt', cwd }).decision, 'deny');
  assert.equal(check({ command: 'git checkout HEAD -- tracked.txt', cwd }).decision, 'deny');
  writeFileSync(join(cwd, 'tracked.txt'), 'a distinct unstaged version\n');
  assert.equal(check({ command: 'git restore --staged tracked.txt', cwd }).decision, 'deny');
  assert.equal(check({ command: 'git restore tracked.txt', cwd }).decision, 'deny');
});

test('actual Git: Git pathspec wildcards and top-level magic retain their semantics', () => {
  const cwd = repository('git-restore-pathspecs');
  writeFileSync(join(cwd, 'tracked.txt'), 'local work\n');
  assert.equal(check({ command: "git restore '*.txt'", cwd }).decision, 'deny');
  assert.equal(check({ command: "git checkout -- ':(glob)*.txt'", cwd }).decision, 'deny');
  mkdirSync(join(cwd, 'subdir'));
  assert.equal(check({ command: "git restore ':(top)tracked.txt'", cwd: join(cwd, 'subdir') }).decision, 'deny');
});

test('actual Git: file-based or unsupported restore scopes do not silently pass', () => {
  const cwd = repository('git-restore-opaque');
  const result = check({ command: 'git restore --pathspec-from-file=paths.txt', cwd });
  assert.equal(result.decision, 'deny');
  assert.ok(rules(result).includes('git.restore-options'));
});

test('actual Git: a directory obstruction cannot masquerade as an empty deleted file', () => {
  const cwd = repository('git-restore-obstruction');
  rmSync(join(cwd, 'tracked.txt'));
  mkdirSync(join(cwd, 'tracked.txt'));
  writeFileSync(join(cwd, 'tracked.txt', 'important.db'), 'ignored data\n');
  writeFileSync(join(cwd, '.gitignore'), 'tracked.txt/\n');
  const result = check({ command: 'git restore tracked.txt', cwd });
  assert.equal(result.decision, 'deny');
  assert.equal(readFileSync(join(cwd, 'tracked.txt', 'important.db'), 'utf8'), 'ignored data\n');
});

test('actual Git: clean uses only a dry run and reports removal candidates', () => {
  const cwd = repository('git-clean');
  assert.equal(check({ command: 'git clean -fd', cwd }).decision, 'pass');
  writeFileSync(join(cwd, 'notes.txt'), 'keep this\n');
  const result = check({ command: 'git clean -fd', cwd });
  assert.equal(result.decision, 'deny');
  assert.match(result.findings[0].evidence.join(' '), /notes.txt/);
  assert.equal(existsSync(join(cwd, 'notes.txt')), true);
});

test('actual Git: a path after -- is not interpreted as a dry-run flag', () => {
  const cwd = repository('git-clean-options');
  writeFileSync(join(cwd, '-n'), 'valuable file\n');
  const result = check({ command: 'git clean -f -- -n', cwd });
  assert.equal(result.decision, 'deny');
  assert.equal(existsSync(join(cwd, '-n')), true);
});

test('actual Git: double-force clean preview includes nested repositories', () => {
  const cwd = repository('git-clean-nested');
  const nested = join(cwd, 'nested');
  mkdirSync(nested);
  git(nested, 'init', '--template=');
  writeFileSync(join(nested, 'valuable.txt'), 'nested project\n');
  const result = check({ command: 'git clean -ffd', cwd });
  assert.equal(result.decision, 'deny');
  assert.match(result.findings[0].evidence.join(' '), /nested/);
  assert.equal(existsSync(join(nested, 'valuable.txt')), true);
});

test('inspection has a shared subprocess budget', () => {
  let calls = 0;
  const result = check(request(Array(20).fill('git reset --hard').join('; ')), {
    inspectGit: () => { calls++; return { ok: true, stdout: '' }; },
  });
  assert.equal(calls, 8);
  assert.equal(result.decision, 'deny');
});

test('probe timeout/failure denies a destructive Git operation', () => {
  const result = check(request('git reset --hard'), {
    inspectGit: () => ({ ok: false, stdout: '', error: 'timed out' }),
  });
  assert.equal(result.decision, 'deny');
  assert.match(result.findings[0].evidence.join(' '), /timed out/);
});

const payload = (command, extra = {}) => JSON.stringify({
  tool_name: 'Bash', cwd: workspace,
  permission_mode: 'bypassPermissions',
  tool_input: { command }, ...extra,
});
for (const agent of ['claude', 'codex']) {
  test(`${agent} hook: deny regardless of permission mode, silent on pass`, () => {
    const denied = runHook(payload('rm -rf /'), agent);
    assert.equal(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision, 'deny');
    assert.equal(denied.exitCode, 0);
    assert.deepEqual(runHook(payload('git status'), agent), { exitCode: 0, stdout: '', stderr: '' });
    const malformed = runHook('{bad', agent);
    assert.equal(JSON.parse(malformed.stdout).hookSpecificOutput.permissionDecision, 'deny');
  });
}

test('hook honors tool workdir while retaining the outer workspace boundary', () => {
  const input = payload('', { tool_input: { command: 'rm -rf workspace', workdir: root } });
  assert.equal(JSON.parse(runHook(input, 'claude').stdout).hookSpecificOutput.permissionDecision, 'deny');
});

test('hook handles argv arrays and unrelated tools', () => {
  assert.equal(runHook(payload(['bash', '-lc', 'rm -rf /']), 'generic').exitCode, 2);
  assert.equal(runHook(payload('rm -rf /', { tool_name: 'Read' }), 'claude').stdout, '');
  assert.equal(runHook('{}', 'generic').exitCode, 2);
});

test('Antigravity adapter uses its camelCase input and top-level deny contract', () => {
  const input = command => JSON.stringify({
    toolCall: { name: 'run_command', args: { CommandLine: command, Cwd: workspace } },
    workspacePaths: [workspace],
  });
  const denied = runHook(input('rm -rf /'), 'antigravity');
  assert.equal(JSON.parse(denied.stdout).decision, 'deny');
  assert.equal(denied.exitCode, 0);
  assert.equal(runHook(input('git status'), 'antigravity').stdout, '');
  assert.equal(JSON.parse(runHook('{}', 'antigravity').stdout).decision, 'deny');
  assert.equal(runHook(JSON.stringify({ toolCall: { name: 'read_file' } }), 'antigravity').stdout, '');
});

test('Antigravity picks the containing workspace without broadening the boundary', () => {
  const input = JSON.stringify({
    toolCall: { name: 'run_command', args: { CommandLine: 'rm -rf .', Cwd: workspace } },
    workspacePaths: [root, workspace],
  });
  assert.equal(JSON.parse(runHook(input, 'antigravity').stdout).decision, 'deny');
});

test('OpenCode adapter throws before a blocked Bash call', async () => {
  const plugin = await NoMeatProxyPlugin({ directory: workspace, worktree: workspace });
  await assert.rejects(
    plugin['tool.execute.before']({ tool: 'bash' }, { args: { command: 'rm -rf /' } }),
    /NoMeatProxy stopped/,
  );
  await plugin['tool.execute.before']({ tool: 'bash' }, { args: { command: 'git status' } });
  await plugin['tool.execute.before']({ tool: 'read' }, { args: {} });
});

test('CLI check is non-executing; config contains an executable absolute hook path', () => {
  const cli = resolve('dist/cli.js');
  const result = spawnSync(process.execPath, [cli, 'check', '--json', 'rm -rf /'], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.equal(JSON.parse(result.stdout).decision, 'deny');
  const config = spawnSync(process.execPath, [cli, 'config', 'claude'], { encoding: 'utf8' });
  assert.equal(config.status, 0);
  const hook = JSON.parse(config.stdout).hooks.PreToolUse[0].hooks[0];
  assert.ok(hook.command.includes(cli) || hook.args?.includes(cli));
  assert.equal(hook.async, undefined);
  const anti = spawnSync(process.execPath, [cli, 'config', 'antigravity'], { encoding: 'utf8' });
  assert.equal(JSON.parse(anti.stdout).nomeatproxy.PreToolUse[0].matcher, 'run_command');
});
