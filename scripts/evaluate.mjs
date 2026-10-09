import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { check } from '../dist/engine.js';

const fixture = mkdtempSync(join(tmpdir(), 'nmp-corpus-'));
const corpus = JSON.parse(readFileSync(new URL('../test/fixtures/corpus.json', import.meta.url), 'utf8'));
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
function git(...args) {
  const result = spawnSync('git', [
    '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false',
    '-c', 'user.name=NoMeatProxy Evaluation', '-c', 'user.email=nomeatproxy@example.invalid', ...args,
  ], {
    cwd: fixture, env: { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(result.stderr);
}
try {
  git('init', '--template=');
  for (const name of ['clean.txt', 'edited.txt', 'staged.txt']) writeFileSync(join(fixture, name), 'committed\n');
  writeFileSync(join(fixture, '.gitignore'), 'ignored/\n');
  git('add', '.');
  git('commit', '-m', 'Evaluation fixture');
  writeFileSync(join(fixture, 'edited.txt'), 'unstaged changes\n');
  writeFileSync(join(fixture, 'staged.txt'), 'staged changes\n');
  git('add', 'staged.txt');
  writeFileSync(join(fixture, 'untracked.txt'), 'untracked work\n');
  mkdirSync(join(fixture, 'ignored'));
  writeFileSync(join(fixture, 'ignored', 'database.db'), 'untracked data\n');
  const results = corpus.map(item => {
    const result = check({ command: item.command, cwd: fixture });
    const correct = item.expected === 'gap'
      ? result.decision === 'pass' && result.limitations.length > 0
      : result.decision === item.expected;
    return { ...item, actual: result.decision, correct, rules: result.findings.map(f => f.rule) };
  });
  const report = {
    date: new Date().toISOString(),
    scope: 'Hand-authored seed corpus, one synthetic Git fixture. Not a representative session or an accuracy guarantee.',
    benignCases: results.filter(r => r.expected === 'pass').length,
    unwantedBlocks: results.filter(r => r.expected === 'pass' && !r.correct).length,
    coveredHazards: results.filter(r => r.expected === 'deny').length,
    missedCoveredHazards: results.filter(r => r.expected === 'deny' && !r.correct).length,
    knownCoverageGaps: results.filter(r => r.expected === 'gap').length,
    unreportedGaps: results.filter(r => r.expected === 'gap' && !r.correct).length,
    results,
  };
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = results.every(r => r.correct) ? 0 : 1;
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
