import { chmodSync, lstatSync, mkdirSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { runHook, type HookAgent, type HookResult } from './adapters/hook.js';

export const defaultSocket = () => join(homedir(), '.nomeatproxy', 'run', 'guard.sock');
export const WIRE_VERSION = 1;
const MAX_FRAME = 256 * 1024;
const AGENTS = new Set<HookAgent>(['claude', 'codex', 'antigravity', 'generic']);

export interface WireRequest {
  version: 1;
  agent: HookAgent;
  cwd: string;
  workspace?: string;
  input: string;
}

export function dispatch(value: unknown): { version: number; result: HookResult } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected request object.');
  const request = value as Partial<WireRequest>;
  if (request.version !== WIRE_VERSION || !AGENTS.has(request.agent as HookAgent) ||
      typeof request.cwd !== 'string' || !isAbsolute(request.cwd) || typeof request.input !== 'string' ||
      (request.workspace !== undefined && (typeof request.workspace !== 'string' || !isAbsolute(request.workspace)))) {
    throw new Error('Unsupported protocol or invalid request.');
  }
  return {
    version: WIRE_VERSION,
    result: runHook(request.input, request.agent!, request.cwd, request.workspace),
  };
}

/** A local acceleration service, not an approval authority or a security boundary against the same OS user. */
export async function serve(path = defaultSocket()): Promise<Server> {
  if (process.platform === 'win32') throw new Error('Resident transport requires POSIX Unix sockets.');
  if (!isAbsolute(path)) throw new Error('Socket path must be absolute.');
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const directory = lstatSync(parent);
  if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== process.getuid!() || (directory.mode & 0o077) !== 0) {
    throw new Error('Socket directory must be owned by this user, not a symlink, and mode 0700.');
  }
  // Never replace an existing file/socket. A crashed service may require an explicit owned-socket cleanup.
  try {
    lstatSync(path);
    throw new Error('Socket path already exists. Stop the existing service or inspect the stale socket first.');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const server = createServer(socket => {
    socket.setTimeout(2000, () => socket.destroy());
    const chunks: Buffer[] = [];
    let bytes = 0;
    let handled = false;
    const reject = () => socket.end(JSON.stringify({ version: WIRE_VERSION, error: 'Invalid or oversized NoMeatProxy request.' }) + '\n');
    socket.on('error', () => {}); // One failed client must not stop the service.
    socket.on('data', chunk => {
      if (handled) return;
      bytes += chunk.length;
      if (bytes > MAX_FRAME) { handled = true; reject(); return; }
      chunks.push(chunk);
      if (!chunk.includes(10)) return;
      handled = true;
      try {
        const data = Buffer.concat(chunks).toString('utf8');
        const newline = data.indexOf('\n');
        if (data.slice(newline + 1).trim()) throw new Error('Only one request per connection.');
        const reply = dispatch(JSON.parse(data.slice(0, newline)));
        socket.end(JSON.stringify(reply) + '\n');
      } catch { reject(); }
    });
    socket.on('end', () => { if (!handled) reject(); });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => {
      try { chmodSync(path, 0o600); resolve(); }
      catch (error) { server.close(); reject(error); }
    });
  });
  return server;
}
