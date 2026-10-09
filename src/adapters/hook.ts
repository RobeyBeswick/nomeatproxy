import { isAbsolute, resolve } from 'node:path';
import { check } from '../engine.js';
import { report } from '../report.js';
import type { CheckResult } from '../types.js';
import { contains } from '../filesystem.js';

export type HookAgent = 'claude' | 'codex' | 'antigravity' | 'generic';
export interface HookResult { exitCode: number; stdout: string; stderr: string }
const SHELL_TOOLS = new Set(['Bash', 'bash', 'shell', 'exec_command', 'shell_command', 'local_shell', 'run_shell_command']);
const quote = (word: string) => `'${word.replace(/'/g, `'\\''`)}'`;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

export function runHook(raw: string, agent: HookAgent, fallbackCwd = process.cwd(), workspace?: string): HookResult {
  try {
    if (Buffer.byteLength(raw, 'utf8') > 131_072) throw new Error('Hook input exceeds 128 KiB.');
    const input: unknown = JSON.parse(raw);
    if (!object(input)) throw new Error('Expected a JSON hook object.');
    if (agent === 'antigravity') {
      if (!object(input.toolCall) || typeof input.toolCall.name !== 'string') throw new Error('Missing Antigravity toolCall.');
      if (input.toolCall.name !== 'run_command') return pass();
      const args = input.toolCall.args;
      if (!object(args) || typeof args.CommandLine !== 'string' || !args.CommandLine.trim()) throw new Error('Missing Antigravity CommandLine.');
      if (typeof args.Cwd !== 'string' || !isAbsolute(args.Cwd)) throw new Error('Antigravity Cwd must be absolute.');
      const roots = Array.isArray(input.workspacePaths)
        ? input.workspacePaths.filter((value): value is string => typeof value === 'string' && isAbsolute(value))
        : [];
      const root = workspace ?? roots.filter(path => contains(path, args.Cwd as string)).sort((a, b) => b.length - a.length)[0] ?? roots[0];
      if (!root) throw new Error('Missing Antigravity workspace boundary.');
      return format(check({ command: args.CommandLine, cwd: args.Cwd, workspace: root }), agent);
    }
    if (typeof input.tool_name === 'string' && !SHELL_TOOLS.has(input.tool_name)) return pass();
    if (input.tool_input !== undefined && !object(input.tool_input)) throw new Error('tool_input must be an object.');
    const tool = object(input.tool_input) ? input.tool_input : input;
    const rawCommand = tool.command ?? tool.cmd;
    const command = typeof rawCommand === 'string'
      ? rawCommand
      : Array.isArray(rawCommand) && rawCommand.length > 0 && rawCommand.every(v => typeof v === 'string')
        ? rawCommand.map(quote).join(' ')
        : undefined;
    if (command === undefined || !command.trim()) throw new Error('Missing or invalid shell command.');
    const outerCwd = typeof input.cwd === 'string' ? input.cwd : fallbackCwd;
    if (!isAbsolute(outerCwd)) throw new Error('Hook cwd must be absolute.');
    const toolCwd = tool.workdir ?? tool.cwd;
    if (toolCwd !== undefined && typeof toolCwd !== 'string') throw new Error('Tool working directory must be a string.');
    const cwd = typeof toolCwd === 'string' ? resolve(outerCwd, toolCwd) : outerCwd;
    return format(check({ command, cwd, workspace: workspace ?? outerCwd }), agent);
  } catch (error) {
    return deny(`NoMeatProxy could not inspect this shell call: ${error instanceof Error ? error.message : 'invalid input'}. Fix the hook input before retrying.`, agent);
  }
}

export function format(result: CheckResult, agent: HookAgent): HookResult {
  return result.decision === 'pass' ? pass() : deny(report(result, false), agent);
}

function pass(): HookResult { return { exitCode: 0, stdout: '', stderr: '' }; }
export function deny(reason: string, agent: HookAgent): HookResult {
  if (agent === 'antigravity') {
    return { exitCode: 0, stdout: JSON.stringify({ decision: 'deny', reason }) + '\n', stderr: '' };
  }
  // Explicit deny works without relying on a native human prompt or an "allow" that overrides other policy.
  if (agent === 'claude' || agent === 'codex') {
    return {
      exitCode: 0,
      stdout: JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: reason,
        },
      }) + '\n',
      stderr: '',
    };
  }
  return { exitCode: 2, stdout: '', stderr: reason + '\n' };
}
