#!/usr/bin/env node
import { accessSync, constants, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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

check never executes the inspected command. Exit 0: no rule blocked; 2: denied.
config prints a settings fragment; merge it with existing settings.
No agent configuration is changed automatically.
`;

function options(args: string[]): { values: Record<string, string>; positionals: string[]; json: boolean } {
  const values: Record<string, string> = {};
  const positionals: string[] = [];
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json') json = true;
    else if (['--cwd', '--workspace', '--agent', '--transport', '--socket'].includes(arg)) {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value.`);
      values[arg.slice(2)] = value;
    } else if (arg === '--') { positionals.push(...args.slice(i + 1)); break; }
    else if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
    else positionals.push(arg);
  }
  return { values, positionals, json };
}

async function main(): Promise<number> {
  const [mode, ...args] = process.argv.slice(2);
  if (!mode || mode === '--help' || mode === 'help') { process.stdout.write(HELP); return 0; }
  const parsed = options(args);
  const cwd = resolve(parsed.values.cwd ?? process.cwd());
  const workspace = parsed.values.workspace ? resolve(parsed.values.workspace) : undefined;
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
    const quote = (word: string) => `'${word.replace(/'/g, `'\\''`)}'`;
    const transport = parsed.values.transport ?? 'node';
    if (!['node', 'resident'].includes(transport)) throw new Error('transport must be node or resident.');
    if (transport === 'node' && parsed.values.socket) throw new Error('--socket requires --transport resident.');
    const binary = resolve(dirname(fileURLToPath(import.meta.url)), 'nomeatproxy-hook');
    if (transport === 'resident') accessSync(binary, constants.X_OK);
    const argv = transport === 'resident'
      ? [binary, '--agent', agent!, ...(parsed.values.socket ? ['--socket', resolve(parsed.values.socket)] : [])]
      : [process.execPath, fileURLToPath(import.meta.url), 'hook', '--agent', agent!];
    const command = [...argv, ...(workspace ? ['--workspace', workspace] : [])].map(quote).join(' ');
    const events = { PreToolUse: [{
      matcher: agent === 'antigravity' ? 'run_command' : 'Bash',
      hooks: [{ type: 'command', command, timeout: 5 }],
    }] };
    process.stdout.write(JSON.stringify(agent === 'antigravity' ? { nomeatproxy: events } : { hooks: events }, null, 2) + '\n');
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
