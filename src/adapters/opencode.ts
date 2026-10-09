import { resolve } from 'node:path';
import { check } from '../engine.js';
import { report } from '../report.js';

/** Structural types keep the policy engine independent of a particular OpenCode SDK release. */
export const NoMeatProxyPlugin = async ({ directory, worktree }: { directory: string; worktree?: string }) => ({
  'tool.execute.before': async (
    input: { tool: string },
    output: { args: Record<string, unknown> },
  ) => {
    if (input.tool !== 'bash') return;
    const { command, workdir } = output.args;
    if (typeof command !== 'string' || !command.trim()) throw new Error('NoMeatProxy: missing Bash command.');
    if (workdir !== undefined && typeof workdir !== 'string') throw new Error('NoMeatProxy: invalid Bash workdir.');
    const result = check({
      command,
      cwd: typeof workdir === 'string' ? resolve(directory, workdir) : directory,
      workspace: worktree || directory,
    });
    if (result.decision === 'deny') throw new Error(report(result, false));
  },
});
