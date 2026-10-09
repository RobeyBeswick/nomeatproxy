import { existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, parse, relative, resolve, sep } from 'node:path';
import type { CheckRequest, Command, Finding, InspectGit } from './types.js';
import { inspectRemoval, uncertain } from './git.js';

export function canonical(path: string): string {
  // Resolve existing symlink ancestors too, even when the final leaf does not exist.
  try { return realpathSync(path); }
  catch {
    const parent = dirname(path);
    return parent === path ? path : resolve(canonical(parent), relative(parent, path));
  }
}

export function contains(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

export function inspectRm(command: Command, request: CheckRequest, inspect: InspectGit): Finding[] {
  const findings: Finding[] = [];
  const flags: string[] = [];
  const operands: number[] = [];
  let afterDash = false;
  for (let i = 1; i < command.argv.length; i++) {
    const argument = command.argv[i]!;
    if (argument === '--' && !afterDash) { afterDash = true; continue; }
    if (!afterDash && argument.startsWith('-')) flags.push(argument);
    else operands.push(i);
  }
  if (flags.includes('--help') || flags.includes('--version')) return [];
  const recursive = flags.some(f => f === '--recursive' || (/^-[^-]/.test(f) && /[rR]/.test(f)));
  if (operands.length > 64) return [uncertain('inspection.limit', 'rm', 'More than 64 deletion targets in one command.')];
  const workspace = canonical(resolve(request.workspace ?? request.cwd));
  const home = canonical(resolve(request.home!));
  for (const index of operands) {
    const operand = command.argv[index]!;
    if (command.contextUnknown || command.dynamic[index] || command.glob[index] || operand.startsWith('~')) {
      findings.push(uncertain('filesystem.unknown-target', operand, 'The deletion target depends on shell expansion or an unresolved working directory.'));
      continue;
    }
    const lexical = resolve(command.cwd, operand);
    const target = canonical(lexical);
    const protectedPaths = [
      resolve(home, '.ssh'), resolve(home, '.aws'), resolve(home, '.gnupg'),
      resolve(home, '.config'), resolve(home, '.codex'), resolve(home, '.claude'),
      ...(request.protectedPaths ?? []).map(p => resolve(workspace, p)),
    ].map(canonical);
    const root = parse(target).root;
    const protectedTarget =
      target === root || target === home ||
      (recursive && contains(target, workspace)) ||
      target.split(sep).includes('.git') ||
      protectedPaths.some(p => contains(p, target) || (recursive && contains(target, p)));
    if (protectedTarget) {
      findings.push({
        rule: 'filesystem.protected-path',
        summary: 'Deletion targets a workspace, system root, home directory, repository metadata, or protected path.',
        targets: [target], evidence: [`Resolved ${JSON.stringify(operand)} from ${command.cwd}.`],
        nextStep: 'Choose the specific disposable file or directory. A human must review any intentional removal of this protected target.',
      });
      continue;
    }
    if (!contains(workspace, target)) {
      findings.push({
        rule: 'filesystem.outside-workspace', summary: 'Deletion reaches outside the session workspace.',
        targets: [target], evidence: [`Workspace boundary: ${workspace}`],
        nextStep: 'Use a target inside the workspace or have a human review and perform the external deletion.',
      });
      continue;
    }
    if (!existsSync(lexical)) continue;
    const loss = inspectRemoval(target, workspace, inspect);
    if (loss) findings.push(loss);
  }
  return findings;
}
