import { homedir } from 'node:os';
import { basename, isAbsolute, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { inspectRm } from './filesystem.js';
import { inspectGit, inspectGitCommand, uncertain } from './git.js';
import { parseCommands } from './shell/parse.js';
import type { WordToken } from './shell/tokenize.js';
import type { CheckRequest, CheckResult, Command, Finding, InspectGit } from './types.js';

export type { CheckRequest, CheckResult, Finding } from './types.js';
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);
const READ_ONLY = new Set(['pwd', 'ls', 'cat', 'head', 'tail', 'wc', 'rg', 'grep', 'echo', 'printf', 'true', 'false']);

export function check(request: CheckRequest, dependencies: { inspectGit?: InspectGit } = {}): CheckResult {
  const start = performance.now();
  const findings: Finding[] = [];
  const limitations = new Set<string>();
  const probe = dependencies.inspectGit ?? inspectGit;
  let gitProbes = 0;
  const inspect: InspectGit = (cwd, args) => {
    const remainingMs = Math.floor(1000 - (performance.now() - start));
    if (++gitProbes > 8 || remainingMs <= 0) {
      return { ok: false, stdout: '', error: 'The shared Git inspection budget was exhausted (8 probes / 1 second).' };
    }
    return probe(cwd, args, Math.min(remainingMs, 400));
  };
  const context: CheckRequest = { ...request, home: request.home ?? homedir() };
  let commandsSeen = 0;
  const add = (items: Finding[]) => findings.push(...items);

  function walk(text: string, initialCwd: string, depth: number, inheritedUnknown = false): void {
    if (depth > 6 || commandsSeen > 128) {
      add([uncertain('inspection.limit', text.slice(0, 100), 'Command nesting or count exceeded the bounded inspection budget.')]);
      return;
    }
    let commands;
    try { commands = parseCommands(text); }
    catch {
      add([uncertain('shell.syntax', text.slice(0, 100), 'The shell command could not be parsed; nothing was executed by the checker.')]);
      return;
    }
    let cwd = initialCwd;
    let contextUnknown = inheritedUnknown;
    // Flattening control flow cannot establish an execution directory. Keep known destructive checks conservative.
    const complexFlow = commands.some(c =>
      ['(', ')', '&', '|', '|&', '||'].includes(c.precededBy ?? '') ||
      ['(', ')', '&', '|', '|&', '||'].includes(c.followedBy ?? '') ||
      ['if', 'then', 'else', 'elif', 'for', 'while', 'until', 'case', 'do', 'function', '{'].includes(c.words[0]?.value ?? ''),
    );
    if (complexFlow) limitations.add('Control flow, pipelines, and background execution are not fully modeled.');
    for (const simple of commands) {
      commandsSeen++;
      if (commandsSeen > 128) {
        add([uncertain('inspection.limit', 'command list', 'More than 128 commands in one tool call.')]);
        return;
      }
      for (const word of simple.words) {
        for (const body of word.substitutions) walk(body, cwd, depth + 1, contextUnknown || complexFlow);
      }
      if (simple.redirects.length) limitations.add('Redirection and heredoc side effects are not inspected.');
      let words = [...simple.words];
      let changedContext = contextUnknown || complexFlow;
      while (words[0] && (
        /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0].value) ||
        ['!', 'then', 'do', 'else', 'if', 'while', 'until', 'time'].includes(words[0].value)
      )) {
        if (/^(GIT_|HOME=|PATH=|CDPATH=)/.test(words[0].value)) changedContext = true;
        words.shift();
      }
      // Known executable wrappers only. Unrecognized wrappers are exposed as coverage gaps.
      for (let count = 0; count < 8 && words.length; count++) {
        const name = basename(words[0]!.value);
        if (name === 'command' && words.slice(1).some(w => ['-v', '-V'].includes(w.value))) {
          words = []; break;
        }
        if (['command', 'exec', 'nohup'].includes(name)) {
          words.shift();
          if (words[0]?.value === '--') words.shift();
          continue;
        }
        if (name === 'sudo') {
          changedContext = true;
          words.shift();
          while (words[0]?.value.startsWith('-')) {
            const option = words.shift()!.value;
            if (['-u', '-g', '-h', '-p', '-D', '--user', '--group', '--chdir'].includes(option)) words.shift();
            if (option === '--') break;
          }
          continue;
        }
        if (name === 'env') {
          words.shift();
          while (words[0]) {
            if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0].value)) {
              changedContext = true; words.shift();
            } else if (words[0].value === '--') { words.shift(); break; }
            else if (words[0].value.startsWith('-')) {
              changedContext = true;
              const option = words.shift()!.value;
              if (['-u', '-C', '--unset', '--chdir'].includes(option)) words.shift();
              else if (option === '-S' || option.startsWith('--split-string')) {
                limitations.add('env split-string execution is not inspected.');
                words = []; break;
              }
            } else break;
          }
          continue;
        }
        break;
      }
      if (!words.length) continue;
      const program = basename(words[0]!.value);
      if (words[0]!.dynamic) {
        limitations.add('A dynamically selected executable is not inspected.');
        continue;
      }
      if (program === 'cd') {
        const target = words[1];
        if (!target || words.length !== 2 || target.dynamic || target.glob || target.value.startsWith('~') ||
            simple.followedBy !== '&&' || simple.precededBy === '&&' || complexFlow) {
          contextUnknown = true;
        } else cwd = resolve(cwd, target.value);
        continue;
      }
      if (SHELLS.has(program)) {
        const index = words.findIndex((w, i) => i > 0 && /^-[a-zA-Z]*c[a-zA-Z]*$/.test(w.value));
        const script = words[index + 1];
        if (index > 0 && script) {
          if (script.dynamic) add([uncertain('shell.dynamic-script', program, 'A shell command string is computed at runtime.')]);
          else walk(script.value, cwd, depth + 1, changedContext);
        } else limitations.add('Shell script files, stdin scripts, and interactive shells are not inspected.');
        continue;
      }
      const command = toCommand(words, cwd, changedContext);
      if (program === 'rm') add(inspectRm(command, context, inspect));
      else if (program === 'git') {
        add(inspectGitCommand(command, inspect));
        limitations.add('Git aliases, hooks, and operations outside the documented Git rules are not inspected.');
      } else if (!READ_ONLY.has(program)) {
        limitations.add(`Effects inside ${JSON.stringify(program)} are not inspected (including scripts, task runners, and remote APIs).`);
      }
    }
  }

  if (!isAbsolute(request.cwd) || (request.workspace !== undefined && !isAbsolute(request.workspace))) {
    findings.push(uncertain('input.cwd', request.cwd, 'cwd and workspace must be absolute paths.'));
  } else if (Buffer.byteLength(request.command, 'utf8') > 65_536) {
    findings.push(uncertain('inspection.limit', 'command', 'Command exceeds the 64 KiB inspection limit.'));
  } else {
    try { walk(request.command, resolve(request.cwd), 0); }
    catch (error) {
      findings.push(uncertain('inspection.failed', 'tool call', error instanceof Error ? error.message : 'Inspection failed.'));
    }
  }
  return {
    decision: findings.length ? 'deny' : 'pass',
    findings,
    limitations: [...limitations],
    elapsedMs: performance.now() - start,
  };
}

function toCommand(words: WordToken[], cwd: string, contextUnknown: boolean): Command {
  return {
    argv: words.map(w => w.value),
    dynamic: words.map(w => w.dynamic),
    glob: words.map(w => w.glob),
    cwd, contextUnknown,
  };
}
