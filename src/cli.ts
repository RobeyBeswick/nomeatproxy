#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { check } from './engine.js';
import { report } from './report.js';
import { runHook, type HookAgent } from './adapters/hook.js';

const HELP = `NoMeatProxy — run autonomously; stop for consequences that deserve a human.

Prototype: POSIX shell deletion and selected destructive Git operations.

  nomeatproxy check [--json] [--cwd PATH] [--workspace PATH] "command"
  nomeatproxy hook --agent claude|codex|antigravity|generic [--workspace PATH]
  nomeatproxy config claude|codex|antigravity [--workspace PATH]
                     [--transport node|resident] [--socket PATH]
  nomeatproxy serve [--socket PATH]
  nomeatproxy install claude|codex|opencode|antigravity [--project]
  nomeatproxy uninstall claude|codex|opencode|antigravity [--project]
  nomeatproxy doctor [claude|codex|opencode|antigravity] [--project]
  nomeatproxy --version

check never executes the inspected command. Exit 0: no rule blocked; 2: denied.
config prints a settings fragment; merge it with existing settings.
install merges a hook into user settings; --project uses the current directory.
Existing settings are backed up. uninstall removes only installer-managed entries.
`;

function options(args: string[]): { values: Record<string, string>; positionals: string[]; json: boolean; project: boolean } {
  const values: Record<string, string> = {};
  const positionals: string[] = [];
  let json = false;
  let project = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json') json = true;
    else if (arg === '--project') project = true;
    else if (arg === '--nomeatproxy-managed') continue; // Identifies installer-owned hook definitions.
    else if (['--cwd', '--workspace', '--agent', '--transport', '--socket'].includes(arg)) {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value.`);
      values[arg.slice(2)] = value;
    } else if (arg === '--') { positionals.push(...args.slice(i + 1)); break; }
    else if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
    else positionals.push(arg);
  }
  return { values, positionals, json, project };
}

async function main(): Promise<number> {
  const [mode, ...args] = process.argv.slice(2);
  if (!mode || mode === '--help' || mode === 'help') { process.stdout.write(HELP); return 0; }
  if (mode === '--version' || mode === '-v') {
    process.stdout.write(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version + '\n');
    return 0;
  }
  const parsed = options(args);
  const cwd = resolve(parsed.values.cwd ?? process.cwd());
  const workspace = parsed.values.workspace ? resolve(parsed.values.workspace) : undefined;
  if (['install', 'uninstall', 'doctor'].includes(mode)) {
    const { AGENTS, agentName, configure, installationStatus } = await import('./setup.js');
    if (parsed.positionals.length > 1) throw new Error('Choose one agent per command.');
    if (parsed.values.transport || parsed.values.socket) throw new Error('Use config for the optional resident transport.');
    const setupOptions = { cwd, project: parsed.project, workspace };
    if (mode === 'doctor') {
      const git = spawnSync('git', ['--version'], { encoding: 'utf8', timeout: 3000 });
      let ok = Number(process.versions.node.split('.')[0]) >= 22 && git.status === 0;
      process.stdout.write(`Node ${process.versions.node}: ${ok ? 'ready' : 'check Node 22+ and Git on PATH'}\n`);
      process.stdout.write(`Git: ${git.status === 0 ? git.stdout.trim() : 'unavailable'}\n`);
      const fixtures = check({ command: 'git status', cwd }).decision === 'pass' &&
        check({ command: 'git push --force origin main', cwd }).decision === 'deny';
      ok &&= fixtures;
      process.stdout.write(`Local checker pass/block fixtures: ${fixtures ? 'passed' : 'FAILED'} (commands were not executed)\n`);
      for (const agent of parsed.positionals.length ? [agentName(parsed.positionals[0])] : AGENTS) {
        try {
          const status = installationStatus(agent, setupOptions);
          process.stdout.write(`${agent}: ${status.detail}\n  ${status.path}\n`);
          if (parsed.positionals.length && !status.installed) ok = false;
        } catch (error) {
          ok = false;
          process.stdout.write(`${agent}: ${error instanceof Error ? error.message : String(error)}\n`);
        }
      }
      process.stdout.write('Restart your agent and check its hook/plugin diagnostics. Codex requires review/trust through /hooks.\n');
      if (process.platform === 'win32') process.stdout.write('Coverage: POSIX shell commands only. PowerShell and cmd.exe commands are not covered; use WSL for the POSIX workflow.\n');
      return ok ? 0 : 1;
    }
    const agent = agentName(parsed.positionals[0]);
    if (agent === 'opencode' && workspace) throw new Error('OpenCode supplies the workspace through its plugin context; omit --workspace.');
    const result = configure(agent, mode === 'uninstall', setupOptions);
    process.stdout.write(`${result.changed ? (mode === 'install' ? 'Installed' : 'Removed') : 'No change needed'}: ${result.path}\n`);
    if (result.backup) process.stdout.write(`Backup: ${result.backup}\n`);
    if (mode === 'install') {
      process.stdout.write(`Restart ${agent}, then run nomeatproxy doctor ${agent}${parsed.project ? ' --project' : ''}.\n`);
      if (agent === 'codex') process.stdout.write('Review and trust the hook through /hooks in Codex before it can run.\n');
      if (agent === 'antigravity') process.stdout.write('Antigravity integration is experimental; live enforcement validation is pending.\n');
      if (process.platform === 'win32') process.stdout.write('POSIX shell coverage only; PowerShell/cmd.exe operations are outside current coverage. WSL is recommended.\n');
    }
    return 0;
  }
  if (mode === 'check') {
    if (parsed.positionals.length !== 1) throw new Error('Pass exactly one quoted command to check.');
    const result = check({ command: parsed.positionals[0]!, cwd, workspace });
    process.stdout.write((parsed.json ? JSON.stringify(result, null, 2) : report(result)) + '\n');
    return result.decision === 'deny' ? 2 : 0;
  }
  if (mode === 'hook') {
    const agent = parsed.values.agent;
    if (!['claude', 'codex', 'antigravity', 'generic'].includes(agent ?? '')) throw new Error('hook requires --agent claude|codex|antigravity|generic.');
    const result = runHook(readFileSync(0, 'utf8'), agent as HookAgent, cwd, workspace);
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    return result.exitCode;
  }
  if (mode === 'config') {
    const agent = parsed.positionals[0];
    if (!['claude', 'codex', 'antigravity'].includes(agent ?? '') || parsed.positionals.length !== 1) throw new Error('config requires claude, codex, or antigravity.');
    const { hookConfig } = await import('./setup.js');
    process.stdout.write(JSON.stringify(hookConfig(agent as 'claude' | 'codex' | 'antigravity', {
      workspace, transport: parsed.values.transport, socket: parsed.values.socket,
    }), null, 2) + '\n');
    return 0;
  }
  if (mode === 'serve') {
    if (parsed.positionals.length) throw new Error('serve does not take positional arguments.');
    const { serve, defaultSocket } = await import('./server.js');
    const path = parsed.values.socket ? resolve(parsed.values.socket) : defaultSocket();
    const server = await serve(path);
    const stop = () => server.close(() => process.exit(0));
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
    process.stderr.write(`NoMeatProxy checker listening on ${path}\n`);
    return 0;
  }
  throw new Error(`Unknown command: ${mode}`);
}

main().then(code => { process.exitCode = code; }, error => {
  process.stderr.write(`NoMeatProxy: ${error instanceof Error ? error.message : String(error)}\n`);
  // Exit 2 is a blocking response for supported PreToolUse hooks, including malformed CLI invocations.
  process.exitCode = 2;
});
