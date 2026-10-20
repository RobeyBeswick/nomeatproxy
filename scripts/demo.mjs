#!/usr/bin/env node
// Replay scripted shell requests through the real CLI hook. Never execute them.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log(`NoMeatProxy interactive demo

  npm run demo            Press Enter to advance each scene.
  npm run demo -- --auto   Run every scene without pauses or screen clearing.

After building, use node scripts/demo.mjs to launch the demo directly.
The demo uses a temporary Git repo and the real generic hook.
Proposed commands are inspected, never executed. No agent setup is required.
Non-interactive input/output automatically uses --auto mode.`);
  process.exit(0);
}
if (args.some(arg => arg !== '--auto')) {
  console.error('Unknown option. Use --auto or --help.');
  process.exit(1);
}

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
if (!existsSync(cli)) {
  console.error('Build the checker first: npm run build');
  process.exit(1);
}

const interactive = !args.includes('--auto') && process.stdin.isTTY && process.stdout.isTTY;
const color = process.stdout.isTTY && !('NO_COLOR' in process.env);
const paint = (code, text) => color ? `\x1b[${code}m${text}\x1b[0m` : text;
const bold = text => paint('1', text);
const muted = text => paint('2', text);
const width = Math.min(92, Math.max(40, (process.stdout.columns ?? 92) - 2));
const line = '-'.repeat(width);
const root = realpathSync(mkdtempSync(join(tmpdir(), 'nomeatproxy-demo-')));
const workspace = join(root, 'workspace');
// Ignore inherited Git overrides, templates, hooks, signing, and user identity.
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
  LC_ALL: 'C',
};
const replacements = [
  [workspace, '<demo>'],
  [root, '<demo-temp>'],
  [fileURLToPath(new URL('../', import.meta.url)).replace(/[\\/]$/, ''), '<checkout>'],
  [homedir(), '~'],
].sort(([a], [b]) => b.length - a.length);
const sanitize = text => replacements.reduce((value, [path, alias]) =>
  value.replaceAll(path, alias).replaceAll(path.replaceAll('\\', '/'), alias), String(text));

function print(text = '') {
  for (const original of sanitize(text).split('\n')) {
    let remaining = original;
    const indent = original.match(/^\s*/)[0];
    while (remaining.length > width) {
      const space = remaining.lastIndexOf(' ', width);
      const end = space > indent.length ? space : width;
      console.log(remaining.slice(0, end));
      remaining = indent + remaining.slice(end).trimStart();
    }
    console.log(remaining);
  }
}

function run(executable, argv, options = {}) {
  const result = spawnSync(executable, argv, {
    cwd: workspace, env, encoding: 'utf8', timeout: 10_000,
    maxBuffer: 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'], ...options,
  });
  if (result.error || result.signal) throw new Error(`Demo subprocess failed: ${result.error?.message ?? result.signal}`);
  return result;
}

function git(...argv) {
  const result = run('git', [
    '-c', 'core.hooksPath=/dev/null',
    '-c', 'core.fsmonitor=false',
    '-c', 'core.autocrlf=false',
    '-c', 'commit.gpgsign=false',
    '-c', 'user.name=NoMeatProxy Demo',
    '-c', 'user.email=demo@example.invalid',
    ...argv,
  ]);
  assert.equal(result.status, 0, `Fixture setup failed: git ${argv.join(' ')}\n${result.stderr}`);
  return result.stdout;
}

const originalApp = "export const greeting = 'Hello';\n";
const editedApp = "export const greeting = 'Hello from my uncommitted edit';\n";
const localData = '{"draftOrders":[{"id":"demo-001","status":"unsaved"}]}\n';
let checks = 0;
let terminal;

function verifyFiles() {
  assert.equal(readFileSync(join(workspace, 'app.js'), 'utf8'), editedApp, 'The edited file must survive.');
  assert.equal(readFileSync(join(workspace, 'data', 'draft-orders.json'), 'utf8'), localData, 'Ignored data must survive.');
}

function inspect(command, expected, rule, evidence) {
  print('Proposed shell command (inspection only):');
  console.log(bold(`  ${command}`));
  print();
  // command is JSON input to the hook, never an executable or shell argument.
  const result = run(process.execPath, [cli, 'hook', '--agent', 'generic', '--workspace', workspace], {
    input: JSON.stringify({ tool_name: 'Bash', cwd: workspace, tool_input: { command } }),
  });
  assert.equal(result.status, expected === 'pass' ? 0 : 2, `Unexpected decision for ${command}\n${result.stderr}`);
  assert.equal(result.stdout, '', 'The generic hook writes no stdout.');
  if (expected === 'pass') {
    assert.equal(result.stderr, '', 'A passing hook must be silent.');
    console.log(paint('32;1', 'PASS'));
    print('Hook returned exit 0, with no output.');
  } else {
    assert.ok(result.stderr.includes(`[${rule}]`), `Missing expected rule ${rule}.\n${result.stderr}`);
    if (evidence) assert.ok(result.stderr.includes(evidence), `Missing expected evidence: ${evidence}`);
    console.log(paint('31;1', 'BLOCK'));
    print(result.stderr.trimEnd());
  }
  verifyFiles();
  checks++;
}

function screen(title) {
  if (interactive) process.stdout.write('\x1b[2J\x1b[H');
  else print();
  console.log(bold('NoMeatProxy'));
  console.log(muted('Local hook replay | scripted requests, real decisions'));
  print(line);
  console.log(bold(title));
  print();
}

async function next(label) {
  if (!interactive) return;
  print();
  await terminal.question(muted(`Enter: ${label}  |  Ctrl-C: quit`));
}

function cleanup() {
  terminal?.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

// Cover normal completion, early input closure, and recording interruptions.
process.once('exit', cleanup);
process.once('SIGINT', () => process.exit(130));
process.once('SIGTERM', () => process.exit(143));

try {
  mkdirSync(workspace);
  git('init', '--quiet', '--initial-branch=main', '--template=');
  writeFileSync(join(workspace, 'app.js'), originalApp);
  writeFileSync(join(workspace, '.gitignore'), 'data/\n');
  git('add', '--', 'app.js', '.gitignore');
  git('commit', '--quiet', '-m', 'Create demo fixture');
  const initialHead = git('rev-parse', 'HEAD').trim();
  writeFileSync(join(workspace, 'app.js'), editedApp);
  mkdirSync(join(workspace, 'data'));
  writeFileSync(join(workspace, 'data', 'draft-orders.json'), localData);
  assert.equal(git('remote').trim(), '', 'The demo repository must have no remotes.');
  git('check-ignore', 'data/draft-orders.json');
  if (interactive) {
    terminal = createInterface({ input: process.stdin, output: process.stdout });
    terminal.on('SIGINT', () => process.exit(130));
  }

  screen('Stop being your agent\'s meat proxy.');
  print('Let routine work through. Stop when work could be lost.');
  print();
  print('One disposable repository:');
  print('  app.js                  an uncommitted edit');
  print('  data/draft-orders.json  local data ignored by Git');
  print();
  print('Real hook checks. No model or agent installation needed.');
  print('Proposed commands are never executed. All fixture data is synthetic.');
  await next('routine work');

  screen('1 / 5   Let routine work through');
  inspect('git status --short', 'pass');
  print();
  print('In a connected agent, a passing hook lets the tool call continue.');
  await next('protect the edit');

  screen('2 / 5   Protect the uncommitted edit');
  print('app.js differs from the copy in Git.');
  print();
  inspect('git restore app.js', 'deny', 'git.uncommitted-work', ' M app.js');
  print();
  print('Verified: the edited file is still intact.');
  await next('preserve a copy, then check again');

  screen('3 / 5   Same command. Different Git state.');
  print('Fixture action (executed in the temporary repository):');
  console.log(bold('  git add app.js'));
  git('add', '--', 'app.js');
  assert.equal(git('show', ':app.js'), editedApp, 'The index must preserve the edit.');
  print('The staged copy now matches the working file.');
  print();
  inspect('git restore app.js', 'pass');
  print();
  print('This restore would retain the edit. Git state changed the decision.');
  await next('inspect ignored data');

  screen('4 / 5   Ignored does not mean disposable');
  print('data/ is in .gitignore. It contains a local draft.');
  print();
  inspect('rm -rf data', 'deny', 'filesystem.uncommitted-work', 'ignored, not backed by Git: data/draft-orders.json');
  print();
  print('Verified: the draft data is still intact.');
  await next('protect remote history');

  screen('5 / 5   Remote history needs a human');
  inspect('git push --force origin main', 'deny', 'git.remote-history');
  print();
  print('No remote is configured or contacted in this demo.');
  await next('closing card');

  verifyFiles();
  assert.equal(git('show', ':app.js'), editedApp);
  assert.equal(git('rev-parse', 'HEAD').trim(), initialHead, 'The committed snapshot must be unchanged.');
  assert.equal(git('remote').trim(), '');
  assert.equal(checks, 5);
  screen('Let it cook. Stop with receipts.');
  print('Five real hook checks. All fixture data preserved.');
  print();
  print('A local accident guard for supported shell operations.');
  print('Not a sandbox: arbitrary scripts and cloud effects are outside coverage.');
  print();
  print('Try it from the checkout: npm run demo');
  print('Setup and agent integrations: README.md');
  await next('finish and remove the temporary repository');
  cleanup();
  process.removeListener('exit', cleanup);
  print();
  print('Demo complete. Temporary repository removed.');
} catch (error) {
  console.error(sanitize(`Demo failed: ${error instanceof Error ? error.message : error}`));
  process.exitCode = 1;
}
