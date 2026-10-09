import { spawnSync } from 'node:child_process';
import { relative, resolve } from 'node:path';
import type { Command, Finding, InspectGit } from './types.js';

/** No shell, network, hooks, external diff, or fsmonitor during an inspection. */
export const inspectGit: InspectGit = (cwd, args, timeoutMs = 400) => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  const result = spawnSync('git', [
    '-c', 'core.fsmonitor=false',
    '-c', 'core.hooksPath=/dev/null',
    '-c', 'core.untrackedCache=false',
    ...args,
  ], {
    cwd,
    env: { ...env, GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    encoding: 'utf8',
    timeout: Math.max(1, Math.min(timeoutMs, 400)),
    maxBuffer: 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return result.status === 0
    ? { ok: true, stdout: result.stdout }
    : { ok: false, stdout: '', error: result.error?.message ?? result.stderr.trim().slice(0, 240) };
};

export function uncertain(rule: string, target: string, reason: string): Finding {
  return {
    rule, summary: 'Cannot establish what this destructive operation would affect.',
    targets: [target], evidence: [reason],
    nextStep: 'Use explicit paths and a standalone command, then check again. A human can review and run an intentional operation outside the agent.',
  };
}

/** Query only the requested paths, with literal pathspecs. Never invoke user-supplied Git options. */
export function status(cwd: string, paths: string[], inspect: InspectGit, literal = true): ReturnType<InspectGit> {
  return inspect(cwd, [
    ...(literal ? ['--literal-pathspecs'] : []),
    'status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none',
    ...(paths.length ? ['--', ...paths] : []),
  ]);
}

export function evidenceFromStatus(output: string): string[] {
  return statusRecords(output).map(record => record.text).slice(0, 8);
}

function statusRecords(output: string): { index: string; worktree: string; path: string; text: string }[] {
  const records = output.split('\0');
  const result: { index: string; worktree: string; path: string; text: string }[] = [];
  for (let i = 0; i < records.length; i++) {
    const record = records[i]!;
    if (!record) continue;
    result.push({ index: record[0]!, worktree: record[1]!, path: record.slice(3), text: record });
    if (/^[RC]|^.[RC]/.test(record)) i++; // second NUL-delimited rename/copy path
  }
  return result;
}

interface RestoreScope {
  paths: string[];
  worktree: boolean;
  index: boolean;
  fromIndex: boolean;
  unsupported?: string;
}

function restoreScope(sub: string, args: string[]): RestoreScope | undefined {
  if (sub === 'checkout') {
    const separator = args.indexOf('--');
    if (separator === -1) return;
    const before = args.slice(0, separator);
    const hasSource = before.some(a => !a.startsWith('-'));
    const unsupported = before.some(a => a.startsWith('-') && !['-f', '--force', '-q', '--quiet'].includes(a));
    return {
      paths: args.slice(separator + 1), worktree: true, index: hasSource, fromIndex: !hasSource,
      unsupported: unsupported ? 'Unsupported checkout options require explicit review.' : undefined,
    };
  }
  if (sub !== 'restore') return;
  const result: RestoreScope = { paths: [], worktree: false, index: false, fromIndex: true };
  let source = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--') { result.paths.push(...args.slice(i + 1)); break; }
    if (arg === '--source' || arg === '-s') {
      source = true;
      if (!args[++i]) result.unsupported = 'Missing restore source.';
    } else if (arg.startsWith('--source=') || (arg.startsWith('-s') && !arg.startsWith('--'))) source = true;
    else if (arg === '--staged') result.index = true;
    else if (arg === '--worktree') result.worktree = true;
    else if (/^-[SWq]+$/.test(arg)) {
      if (arg.includes('S')) result.index = true;
      if (arg.includes('W')) result.worktree = true;
    } else if (['--quiet', '--progress', '--no-progress'].includes(arg)) continue;
    else if (arg.startsWith('-')) result.unsupported = 'Interactive, file-based pathspec, submodule, and other restore options need separate inspection.';
    else result.paths.push(arg);
  }
  if (!result.index && !result.worktree) result.worktree = true;
  result.fromIndex = !source && !result.index;
  return result;
}

function inspectRestore(scope: RestoreScope, cwd: string, inspect: InspectGit): Finding[] {
  if (scope.unsupported || scope.paths.length === 0 || scope.paths.length > 64) {
    return [uncertain('git.restore-options', cwd, scope.unsupported ?? 'Provide between one and 64 explicit Git pathspecs.')];
  }
  // These are Git pathspecs, not filesystem literals. Quoted *.ts and :(top) must keep Git's semantics.
  const state = status(cwd, scope.paths, inspect, false);
  if (!state.ok) return [uncertain('git.unverified-worktree', cwd, state.error ?? 'Cannot inspect the selected paths.')];
  const losses = statusRecords(state.stdout).filter(record => {
    if (record.index === 'U' || record.worktree === 'U' || ['AA', 'DD'].includes(record.index + record.worktree)) return true;
    if (scope.worktree && scope.fromIndex) {
      // The index retains staged content. Keep deletions conservative: a "missing"
      // tracked file can be obstructed by a directory containing ignored data.
      return record.index !== '?' && record.worktree !== ' ';
    }
    if (scope.worktree) return true; // an explicit source can overwrite index, worktree, and untracked content
    // Unstaging retains a staged version when the worktree still has the same bytes.
    return ![' ', '?'].includes(record.index) && record.worktree !== ' ';
  });
  const evidence = losses.map(record => record.text);
  if (scope.worktree && !scope.fromIndex) {
    const ignored = inspect(cwd, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z', '--', ...scope.paths]);
    if (!ignored.ok) return [uncertain('git.unverified-worktree', cwd, ignored.error ?? 'Cannot inventory ignored paths.')];
    evidence.push(...ignored.stdout.split('\0').filter(Boolean).map(path => `ignored, not backed by Git: ${path}`));
  }
  if (!evidence.length) return [];
  return [{
    rule: 'git.uncommitted-work',
    summary: 'The selected Git paths contain work this operation could discard.',
    targets: scope.paths,
    evidence: evidence.slice(0, 8),
    nextStep: 'Preserve the affected versions before restoring them. Changes outside these pathspecs do not block this operation.',
  }];
}

export function inspectRemoval(target: string, cwd: string, inspect: InspectGit): Finding | undefined {
  const state = status(cwd, [relative(cwd, target) || '.'], inspect);
  if (!state.ok) return uncertain('filesystem.unverified-removal', target, state.error ?? 'Git could not verify recoverability.');
  const ignored = inspect(cwd, [
    '--literal-pathspecs', 'ls-files', '--others', '--ignored', '--exclude-standard', '-z',
    '--', relative(cwd, target) || '.',
  ]);
  if (!ignored.ok) return uncertain('filesystem.unverified-removal', target, ignored.error ?? 'Ignored-file inventory failed.');
  if (!state.stdout && !ignored.stdout) return;
  return {
    rule: 'filesystem.uncommitted-work',
    summary: 'Deletion would affect files with uncommitted or untracked work.',
    targets: [target], evidence: [
      ...evidenceFromStatus(state.stdout),
      ...ignored.stdout.split('\0').filter(Boolean).slice(0, 8).map(p => `ignored, not backed by Git: ${p}`),
    ].slice(0, 8),
    nextStep: 'Preserve the affected work before deleting it. Ignored files are not assumed disposable; human-configured disposable paths are planned.',
  };
}

export function inspectGitCommand(command: Command, inspect: InspectGit): Finding[] {
  const args = command.argv.slice(1);
  let cwd = command.cwd;
  let uncertainContext = command.contextUnknown;
  let offset = 1;
  while (args[0]?.startsWith('-')) {
    const option = args.shift()!;
    offset++;
    if (option === '-C') {
      const directory = args.shift();
      if (!directory || command.dynamic[offset] || command.glob[offset]) uncertainContext = true;
      else cwd = resolve(cwd, directory);
      offset++;
    } else if (option.startsWith('-C') && option.length > 2) {
      if (command.dynamic[offset - 1] || command.glob[offset - 1]) uncertainContext = true;
      else cwd = resolve(cwd, option.slice(2));
    } else {
      uncertainContext = true;
      if (['-c', '--git-dir', '--work-tree', '--namespace', '--config-env'].includes(option)) {
        args.shift(); offset++;
      }
    }
  }
  const sub = args.shift();
  offset++;
  const separator = args.indexOf('--');
  const optionArgs = separator === -1 ? args : args.slice(0, separator);
  const flags = optionArgs.filter(a => a.startsWith('-'));
  const short = (letter: string) => flags.some(a => /^-[^-]/.test(a) && a.slice(1).includes(letter));
  if (!sub || flags.includes('--help')) return [];
  if (sub === 'push' && (short('n') || flags.includes('--dry-run'))) return [];
  const forcedPush = sub === 'push' && (
    short('f') || short('d') ||
    flags.some(a => a === '--mirror' || a === '--delete' || a.startsWith('--force')) ||
    args.some(a => a.startsWith('+') || a.startsWith(':'))
  );
  if (forcedPush) {
    return [{
      rule: 'git.remote-history',
      summary: 'This push can rewrite or delete remote history.',
      targets: args.filter(a => !a.startsWith('-')),
      evidence: ['Force, deletion, or mirror semantics were requested; remote ownership has not been established.'],
      nextStep: 'Use a normal push, or have a human review the exact remote and refs and perform the operation outside the agent.',
    }];
  }
  const clean = sub === 'clean';
  if (clean && (short('n') || short('i') || flags.includes('--dry-run') || flags.includes('--interactive'))) return [];
  const destructive = (sub === 'reset' && flags.includes('--hard')) ||
    (sub === 'checkout' && (short('f') || flags.includes('--force') || args.includes('--'))) ||
    (sub === 'switch' && (short('f') || flags.includes('--force') || flags.includes('--discard-changes'))) ||
    sub === 'restore' ||
    (clean && (short('f') || flags.includes('--force')));
  if (!destructive) return [];
  if (uncertainContext || command.dynamic.some(Boolean) || command.glob.some(Boolean)) {
    return [uncertain('git.unknown-target', cwd, 'Dynamic arguments or context-changing wrappers prevent reliable inspection.')];
  }
  const scope = restoreScope(sub, args);
  if (scope) return inspectRestore(scope, cwd, inspect);
  if (clean) {
    // Dry-run only, with our own arguments. Unsupported exclusions/options get no optimistic verdict.
    if (flags.some(a => a.startsWith('--') && a !== '--force') ||
        flags.some(a => /^-[^-]/.test(a) && !/^-+[fdxX]+$/.test(a))) {
      return [uncertain('git.clean-options', cwd, 'These clean options are not supported by the preview inspector.')];
    }
    const preview = inspect(cwd, [
      'clean', '--dry-run',
      // A second force flag includes nested repositories. Preserve it in the dry run.
      ...(flags.reduce((count, flag) => count + (flag === '--force' ? 1 : /^-[^-]/.test(flag) ? [...flag].filter(c => c === 'f').length : 0), 0) >= 2 ? ['-ff'] : []),
      ...(short('d') ? ['-d'] : []),
      ...(short('x') ? ['-x'] : short('X') ? ['-X'] : []),
      '--', ...optionArgs.filter(a => !a.startsWith('-')),
      ...(separator === -1 ? [] : args.slice(separator + 1)),
    ]);
    if (!preview.ok) return [uncertain('git.clean-preview', cwd, preview.error ?? 'Dry-run failed.')];
    if (!preview.stdout.trim()) return [];
    return [{
      rule: 'git.untracked-work',
      summary: 'Git clean would remove files or directories outside tracked history.',
      targets: [cwd], evidence: preview.stdout.trim().split('\n').slice(0, 8),
      nextStep: 'Review the dry-run output and preserve anything valuable before cleaning.',
    }];
  }
  // Conservatively inspect the repository. Path-sensitive reset/restore analysis is a later refinement.
  const state = status(cwd, [], inspect);
  if (!state.ok) return [uncertain('git.unverified-worktree', cwd, state.error ?? 'Cannot inspect the worktree.')];
  if (!state.stdout) return [];
  return [{
    rule: 'git.uncommitted-work',
    summary: 'A destructive Git operation was requested while the worktree contains uncommitted work.',
    targets: [cwd], evidence: evidenceFromStatus(state.stdout),
    nextStep: 'Preserve the changes first. This initial inspector checks the whole worktree and may include files outside the command’s target.',
  }];
}
