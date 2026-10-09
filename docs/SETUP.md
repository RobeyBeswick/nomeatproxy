# Agent setup

Build from the repository root with Node.js 22+ and Git:

```bash
npm ci
npm run build
```

Run the commands below from the NoMeatProxy checkout. The workspace argument is
the project your agent will work in; use its absolute path.

## Claude Code and Codex

Generate a settings fragment using absolute executable paths:

```bash
node dist/cli.js config claude --workspace /absolute/path/to/your/project
node dist/cli.js config codex --workspace /absolute/path/to/your/project
```

Merge the fragment into the agent's existing settings:

- Claude Code: `.claude/settings.json` or `~/.claude/settings.json`.
- Codex: `.codex/hooks.json` or `~/.codex/hooks.json`, then review/trust the hook through `/hooks`.

Use a fixed workspace boundary for each project. The generated settings match
`Bash` tool calls. They do not establish coverage of every tool or execution path.
The hook returns an explicit `deny` on a finding and stays silent otherwise; it
does not depend on permission prompts being enabled.

`config` only prints JSON. It does not overwrite settings or install a hook.
Restart/reload the agent as needed, then verify the hook with non-executing
fixtures and the agent's hook diagnostics before relying on it.

## Optional fast transport

A small native client can call a resident checker over a private Unix socket,
avoiding Node startup on every tool call. It uses the same policy engine and
does not cache permissions. Building this optional client requires Go 1.22+.

```bash
npm run build
npm run build:native

# Keep this process running in a separate terminal.
node dist/cli.js serve
```

Then generate the desired agent's fragment:

```bash
node dist/cli.js config claude --transport resident --workspace /absolute/path/to/your/project
```

The default socket is `~/.nomeatproxy/run/guard.sock`. Both commands also accept
`--socket /absolute/path/to/private-directory/guard.sock`. The directory must be
owned by the current user with mode 0700; the service creates a missing directory.

The client blocks when the checker is absent, stalls, or returns invalid output.
Restart the checker after rebuilding or changing policy: it retains the loaded
code until restarted. Ctrl-C stops it and removes the listening socket. After an
abrupt crash, inspect any remaining socket before removing it; the service will
not overwrite an existing endpoint.

Local benchmark: the native routine path measured **9.2 ms p95**, including
fresh client startup and the round trip. This excludes agent scheduling.
The direct Node CLI remains available and is slower.

## OpenCode

The adapter runs the engine in the plugin process, avoiding CLI process startup.
After building, add a local plugin with an absolute import:

```ts
// .opencode/plugins/nomeatproxy.ts
export { NoMeatProxyPlugin } from "/absolute/path/to/nomeatproxy/dist/adapters/opencode.js";
```

It inspects the Bash tool's command and workdir at `tool.execute.before`, then
throws on a denial. Other tools are currently outside its scope.

## Antigravity

```bash
node dist/cli.js config antigravity --workspace /absolute/path/to/your/project
# Add --transport resident to use the optional native client.
```

Merge this **named-hook** fragment into `.agents/hooks.json` or
`~/.gemini/config/hooks.json`. Antigravity uses a different schema from Claude
and Codex: `toolCall.args.CommandLine` / `Cwd` on input and a top-level
`{"decision":"deny","reason":"..."}` on a block.

Only `run_command` is covered by this adapter. It has protocol tests against the
documented contract; CLI/IDE enforcement and silent-pass behavior remain
unverified. Antigravity has now been installed; its live compatibility test is
still pending.

## Generic callers

`nomeatproxy hook --agent generic` accepts JSON on stdin, exits 2 to block, and
puts the explanation on stderr. A caller must explicitly honor that contract.

## Development

```bash
npm run check   # typecheck, build, behavior and protocol tests
npm run bench   # engine timings and CLI timings including process startup
npm run evaluate     # labeled seed corpus, including documented gaps
npm run test:native  # build the optional client and exercise transport failures
```

`npm run check` includes native integration tests when the binary is built;
otherwise those tests are explicitly skipped. The routine hook target is p95
under 50 ms end to end. The resident benchmark meets that target on this machine;
full-agent scheduling and tail latency need further measurement.
See [measurements](BENCHMARKS.md) for scope and exclusions.

- [Product and technical design](DESIGN.md)
- [Implementation roadmap](ROADMAP.md)
- [Agent compatibility and reproduction](COMPATIBILITY.md)
- [Source entry point](../src/engine.ts)

No telemetry, model calls, cloud calls, automatic approval grants, or automatic
execution of checked commands are included. This prototype does use read-only
Git subprocesses for selected destructive operations.

MIT. Shell parsing code is adapted from PlanSentry; see [NOTICE](../NOTICE).
