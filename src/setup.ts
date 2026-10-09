import { randomUUID } from 'node:crypto';
import { accessSync, constants, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tokenize } from './shell/tokenize.js';

export const AGENTS = ['claude', 'codex', 'opencode', 'antigravity'] as const;
export type Agent = typeof AGENTS[number];
type ObjectValue = Record<string, unknown>;
const MARKER = '--nomeatproxy-managed';
const WINDOWS_MARKER = '/* nomeatproxy-managed */';
const PLUGIN_MARKER = '// Managed by NoMeatProxy. Re-run nomeatproxy install opencode to update.\n';
export const cliPath = fileURLToPath(new URL('./cli.js', import.meta.url));

export interface SetupOptions {
  cwd?: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
  project?: boolean;
  workspace?: string;
}

export interface CommandOptions {
  workspace?: string;
  transport?: string;
  socket?: string;
  managed?: boolean;
  platform?: NodeJS.Platform;
  executable?: string;
  cli?: string;
}

export function agentName(value: string | undefined): Agent {
  if (!AGENTS.includes(value as Agent)) throw new Error(`Choose an agent: ${AGENTS.join(', ')}.`);
  return value as Agent;
}

function object(value: unknown, label: string): ObjectValue {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as ObjectValue;
}

const quote = (word: string) => `'${word.replace(/'/g, `'\\''`)}'`;

export function hookHandler(agent: Exclude<Agent, 'opencode'>, options: CommandOptions = {}): ObjectValue {
  const platform = options.platform ?? process.platform;
  const transport = options.transport ?? 'node';
  if (!['node', 'resident'].includes(transport)) throw new Error('transport must be node or resident.');
  if (transport === 'node' && options.socket) throw new Error('--socket requires --transport resident.');
  const cli = options.cli ?? cliPath;
  const binary = resolve(dirname(cli), 'nomeatproxy-hook');
  if (transport === 'resident') {
    if (platform === 'win32') throw new Error('Resident transport requires macOS or Linux.');
    if (options.managed) throw new Error('Use config to set up the optional resident transport.');
    accessSync(binary, constants.X_OK);
  }
  const argv = transport === 'resident'
    ? [binary, '--agent', agent, ...(options.socket ? ['--socket', resolve(options.socket)] : [])]
    : [options.executable ?? process.execPath, cli, 'hook', '--agent', agent];
  if (options.workspace) argv.push('--workspace', resolve(options.workspace));
  if (options.managed) argv.push(MARKER);
  if (platform === 'win32') {
    // Claude's exec form bypasses cmd.exe / PowerShell / Git Bash quoting entirely.
    if (agent === 'claude') return { type: 'command', command: argv[0], args: argv.slice(1), timeout: 5 };
    // Other hosts accept only shell strings. This fixed Node bootstrap works in
    // cmd.exe, PowerShell and Git Bash without interpreting paths as shell code.
    // Only argv is encoded; the policy still runs in this one Node process.
    const encoded = Buffer.from(JSON.stringify(argv)).toString('base64');
    const script = `${options.managed ? WINDOWS_MARKER + ' ' : ''}process.argv=JSON.parse(Buffer.from('${encoded}','base64'));import(require('node:url').pathToFileURL(process.argv[1]).href)`;
    return { type: 'command', command: `node -e "${script}"`, timeout: 5 };
  }
  return { type: 'command', command: argv.map(quote).join(' '), timeout: 5 };
}

export function hookConfig(agent: Exclude<Agent, 'opencode'>, options: CommandOptions = {}): ObjectValue {
  const events = { PreToolUse: [{
    matcher: agent === 'antigravity' ? 'run_command' : 'Bash',
    hooks: [hookHandler(agent, options)],
  }] };
  return agent === 'antigravity' ? { nomeatproxy: events } : { hooks: events };
}

export function configPath(agent: Agent, options: SetupOptions = {}): string {
  const home = options.home ?? homedir();
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  switch (agent) {
    case 'claude': return join(options.project ? join(cwd, '.claude') : env.CLAUDE_CONFIG_DIR || join(home, '.claude'), 'settings.json');
    case 'codex': return join(options.project ? join(cwd, '.codex') : env.CODEX_HOME || join(home, '.codex'), 'hooks.json');
    case 'antigravity': return join(options.project ? join(cwd, '.agents') : join(home, '.gemini', 'config'), 'hooks.json');
    case 'opencode': return join(options.project ? join(cwd, '.opencode') : join(env.XDG_CONFIG_HOME || join(home, '.config'), 'opencode'), 'plugins', 'nomeatproxy.js');
  }
}

function readExisting(path: string): string | undefined {
  try {
    if (!lstatSync(path).isFile()) throw new Error(`Expected a regular file, not a symlink or directory: ${path}`);
    return readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
}

function json(text: string | undefined): ObjectValue {
  try { return object(JSON.parse(text?.replace(/^\uFEFF/, '') ?? '{}'), 'Settings'); }
  catch { throw new Error('Settings are not a valid JSON object. Fix the file first; nothing has been changed.'); }
}

function isOurs(handler: unknown): boolean {
  if (!handler || typeof handler !== 'object') return false;
  const h = handler as ObjectValue;
  return h.type === 'command' && (
    (Array.isArray(h.args) && h.args.includes(MARKER)) ||
    (typeof h.command === 'string' && (h.command.includes(`'${MARKER}'`) || h.command.includes(WINDOWS_MARKER)))
  );
}

/** Validate the part we edit, preserving all other settings and hook types. */
function groups(events: ObjectValue): ObjectValue[] {
  const value = events.PreToolUse === undefined ? [] : events.PreToolUse;
  if (!Array.isArray(value)) throw new Error('PreToolUse must be an array; nothing has been changed.');
  return value.map(group => {
    const entry = object(group, 'Hook group');
    if (!Array.isArray(entry.hooks)) throw new Error('Hook group must contain a hooks array; nothing has been changed.');
    return entry;
  });
}

function removeManaged(entries: ObjectValue[]): ObjectValue[] {
  return entries.flatMap(entry => {
    const hooks = entry.hooks as unknown[];
    const keep = hooks.filter(handler => !isOurs(handler));
    if (keep.length === hooks.length) return [entry];
    return keep.length ? [{ ...entry, hooks: keep }] : [];
  });
}

function pluginContent(): string {
  const adapter = new URL('./adapters/opencode.js', import.meta.url).href;
  return `${PLUGIN_MARKER}export { NoMeatProxyPlugin } from ${JSON.stringify(adapter)};\n`;
}

/** Unique backups and atomic replacement; never leave half-written settings. */
function replaceFile(path: string, before: string | undefined, after: string | undefined): { changed: boolean; backup?: string } {
  if (before === after) return { changed: false };
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const suffix = randomUUID();
  const backup = before === undefined ? undefined : `${path}.nomeatproxy-backup-${suffix}`;
  const temporary = `${path}.nomeatproxy-tmp-${suffix}`;
  const mode = before === undefined ? 0o600 : lstatSync(path).mode & 0o777;
  try {
    if (after !== undefined) writeFileSync(temporary, after, { encoding: 'utf8', mode, flag: 'wx' });
    if (readExisting(path) !== before) throw new Error('Settings changed during installation. Please try again.');
    if (backup) writeFileSync(backup, before!, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    if (after === undefined) unlinkSync(path);
    else renameSync(temporary, path);
    return { changed: true, ...(backup ? { backup } : {}) };
  } finally {
    try { unlinkSync(temporary); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

export function configure(agent: Agent, remove: boolean, options: SetupOptions = {}): { path: string; changed: boolean; backup?: string } {
  const path = configPath(agent, options);
  const before = readExisting(path);
  if (remove && before === undefined) return { path, changed: false };
  if (agent === 'opencode') {
    if (before !== undefined && !before.startsWith(PLUGIN_MARKER)) throw new Error(`An unmanaged plugin already exists at ${path}. Move it or merge it manually.`);
    return { path, ...replaceFile(path, before, remove ? undefined : pluginContent()) };
  }
  const settings = json(before);
  const key = agent === 'antigravity' ? 'nomeatproxy' : 'hooks';
  if (remove && settings[key] === undefined) return { path, changed: false };
  const events = object(settings[key] === undefined ? {} : settings[key], key);
  const original = groups(events);
  const cleaned = removeManaged(original);
  if (agent === 'antigravity' && settings[key] !== undefined && cleaned.length === original.length && !original.some(g => (g.hooks as unknown[]).some(isOurs))) {
    throw new Error('The Antigravity hook name "nomeatproxy" is already in use by an unmanaged hook. Merge it manually.');
  }
  if (!remove) {
    const workspace = options.workspace ?? (options.project ? resolve(options.cwd ?? process.cwd()) : undefined);
    const expected = hookHandler(agent, { workspace, managed: true });
    // A repeat install with the same package and scope leaves even formatting untouched.
    const owned = original.filter(g => (g.hooks as unknown[]).some(isOurs));
    if (owned.length === 1 && owned[0]!.matcher === (agent === 'antigravity' ? 'run_command' : 'Bash') &&
        (owned[0]!.hooks as unknown[]).filter(isOurs).length === 1 &&
        JSON.stringify((owned[0]!.hooks as unknown[]).find(isOurs)) === JSON.stringify(expected)) {
      return { path, changed: false };
    }
    cleaned.push({ matcher: agent === 'antigravity' ? 'run_command' : 'Bash', hooks: [expected] });
  } else if (JSON.stringify(original) === JSON.stringify(cleaned)) return { path, changed: false };
  if (cleaned.length) events.PreToolUse = cleaned;
  else delete events.PreToolUse;
  if (Object.keys(events).length) settings[key] = events;
  else delete settings[key];
  return { path, ...replaceFile(path, before, JSON.stringify(settings, null, 2) + '\n') };
}

export function installationStatus(agent: Agent, options: SetupOptions = {}): { path: string; installed: boolean; detail: string } {
  const path = configPath(agent, options);
  const text = readExisting(path);
  if (text === undefined) return { path, installed: false, detail: 'not installed in this scope' };
  if (agent === 'opencode') {
    const installed = text === pluginContent();
    return { path, installed, detail: installed ? 'plugin points to this installation' : 'plugin differs; re-run install to update a managed plugin' };
  }
  const settings = json(text);
  const events = object(settings[agent === 'antigravity' ? 'nomeatproxy' : 'hooks'] ?? {}, 'Hooks');
  const matching = groups(events).filter(g => g.matcher === (agent === 'antigravity' ? 'run_command' : 'Bash'));
  const handlers = matching.flatMap(g => g.hooks as ObjectValue[]).filter(isOurs);
  const enabled = handlers.length === 1 && settings.disableAllHooks !== true && events.enabled !== false &&
    handlers[0]!.async !== true && handlers[0]!.asyncRewake !== true;
  let current = false;
  if (enabled) {
    const handler = handlers[0]!;
    let argv: unknown[];
    if (Array.isArray(handler.args)) argv = [handler.command, ...handler.args];
    else if (typeof handler.command === 'string' && handler.command.includes(WINDOWS_MARKER)) {
      const encoded = /Buffer\.from\('([A-Za-z0-9+/=]+)','base64'\)/.exec(handler.command)?.[1];
      argv = encoded ? JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) : [];
    } else {
      const tokens = tokenize(String(handler.command));
      argv = tokens.every(t => t.type === 'word' && !t.dynamic && !t.glob) ? tokens.map(t => t.value) : [];
    }
    current = Array.isArray(argv) && argv[0] === process.execPath && argv[1] === cliPath;
  }
  const installed = enabled && current;
  return {
    path, installed,
    detail: installed ? 'managed hook points to this installation; host loading and trust not verified'
      : enabled ? 'managed hook points elsewhere; re-run install to update it'
      : 'managed hook missing, duplicated, or disabled',
  };
}
