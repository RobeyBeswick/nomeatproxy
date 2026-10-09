// Install the real tarball into a disposable prefix, with lifecycle scripts
// disabled: consumers must receive ready-to-run JS and need no compiler or Go.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const source = fileURLToPath(new URL('../', import.meta.url));
const stage = mkdtempSync(join(tmpdir(), 'nmp-package-'));
const npm = process.env.npm_execpath;
if (!npm) throw new Error('Run with npm run test:package.');
const run = (executable, args, options = {}) => {
  const result = spawnSync(executable, args, { cwd: source, encoding: 'utf8', timeout: 120_000, ...options });
  assert.equal(result.status, 0, `${executable} ${args.join(' ')}\n${result.error ?? ''}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
};
try {
  const output = run(process.execPath, [npm, 'pack', '--json', '--pack-destination', stage]);
  const packed = JSON.parse(output.slice(output.indexOf('[')))[0];
  const files = packed.files.map(f => f.path);
  assert.ok(files.includes('dist/cli.js'));
  assert.ok(files.includes('dist/adapters/opencode.js'));
  assert.ok(files.includes('dist/engine.d.ts'));
  assert.ok(files.includes('LICENSE') && files.includes('NOTICE'));
  assert.ok(!files.some(f => /nomeatproxy-hook|\.local\.json|node_modules|^test\/|^src\//.test(f)), files.join('\n'));
  const prefix = join(stage, 'prefix with spaces');
  run(process.execPath, [npm, 'install', '--global', '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund', join(stage, packed.filename)]);
  const bin = process.platform === 'win32' ? join(prefix, 'nomeatproxy.cmd') : join(prefix, 'bin', 'nomeatproxy');
  assert.ok(existsSync(bin), 'npm creates the platform CLI entrypoint');
  const invoke = (args, cwd = stage) => process.platform === 'win32'
    ? run(`"${bin}"`, args, { cwd, shell: true })
    : run(bin, args, { cwd });
  const version = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')).version;
  assert.equal(invoke(['--version']).trim(), version);
  for (const agent of ['claude', 'codex', 'opencode', 'antigravity']) {
    const cwd = join(stage, `project-${agent}`);
    mkdirSync(cwd);
    invoke(['install', agent, '--project'], cwd);
    assert.match(invoke(['install', agent, '--project'], cwd), /No change needed/);
    assert.match(invoke(['doctor', agent, '--project'], cwd), /fixtures: passed/);
    invoke(['uninstall', agent, '--project'], cwd);
    assert.match(invoke(['uninstall', agent, '--project'], cwd), /No change needed/);
  }
  const packageRoot = process.platform === 'win32'
    ? join(prefix, 'node_modules', 'nomeatproxy')
    : join(prefix, 'lib', 'node_modules', 'nomeatproxy');
  const importer = `import { check } from ${JSON.stringify(pathToFileURL(join(packageRoot, 'dist', 'engine.js')).href)}; if(check({command:'git push --force origin main',cwd:process.cwd()}).decision!=='deny') process.exit(1)`;
  run(process.execPath, ['--input-type=module', '-e', importer], { cwd: stage });
  console.log(`Package smoke test passed: ${packed.filename}, ${files.length} files, ${Math.ceil(packed.size / 1024)} KiB compressed.`);
} finally {
  rmSync(stage, { recursive: true, force: true });
}
