# Installation and agent setup

The standard package needs **Node.js 22+** and **Git on PATH**. There are no
production npm dependencies and no Go requirement. The optional resident transport
has its own requirements below.

## Install the CLI

NoMeatProxy is currently in a private repository, with public npm publication
disabled. Download and unzip the `nomeatproxy-npm` artifact from the latest
successful **Check** run in the private repository's GitHub Actions tab.
The included tarball contains compiled JavaScript and declarations; installing
it requires no compiler:

```sh
npm install --global ./nomeatproxy-0.0.1.tgz
```

Use the package artifact or a checkout build, rather than a direct npm Git URL.
Direct global Git installation produced a broken cache symlink in local testing.

To make that tarball from a checkout:

```sh
npm ci
npm pack
npm install --global ./nomeatproxy-0.0.1.tgz
```

These npm commands work in a POSIX shell, PowerShell, or cmd.exe. Ensure the npm
global executable directory is on your PATH, then check `nomeatproxy --version`.
If PowerShell's execution policy blocks the npm shim, use `npm.cmd` and
`nomeatproxy.cmd`, or use cmd.exe; no execution-policy change is required.

After a public release, the installation command will be
`npm install --global nomeatproxy`. That registry release is **not available yet**.
Homebrew is a possible additional route for macOS/Linux, but no tap or formula
has been published. npm is the first distribution route.

## Attach your agent

Run the command for each agent you use:

```sh
nomeatproxy install claude
nomeatproxy install codex
nomeatproxy install opencode
nomeatproxy install antigravity
```

By default, this installs for the current user. For a single project, run
`nomeatproxy install claude --project` from its root, substituting your agent.
Project hooks pin the workspace boundary to that directory. Global hooks derive
the boundary from the tool's working directory; use project setup when the agent
needs a fixed boundary across directory changes. OpenCode supplies its workspace
through the plugin context.

| Agent | User configuration | Project configuration |
|---|---|---|
| Claude Code | `~/.claude/settings.json` | `.claude/settings.json` |
| Codex | `~/.codex/hooks.json` | `.codex/hooks.json` |
| OpenCode | `~/.config/opencode/plugins/nomeatproxy.js` | `.opencode/plugins/nomeatproxy.js` |
| Antigravity | `~/.gemini/config/hooks.json` | `.agents/hooks.json` |

User paths respect `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, and `XDG_CONFIG_HOME` for
their respective agents. Project paths always use the current project.

The installer preserves unrelated settings and hooks, refuses malformed JSON, and
backs up existing files before changing them. Backups sit beside the original
with a `.nomeatproxy-backup-<unique-id>` suffix. Reinstalling the same configuration
does nothing. Keep settings and backups private: they can contain personal paths
or other sensitive configuration. Prefer user-level installation for shared repos.
An existing unmanaged `nomeatproxy.js` plugin or Antigravity hook named
`nomeatproxy` needs a manual merge.

Restart the agent after installation. **In Codex, review and trust the hook through
`/hooks`**; installing the file does not grant trust. Check its hook/plugin
diagnostics, then run:

```sh
nomeatproxy doctor claude
```

Use the same agent and `--project` scope as your install. `doctor` checks Node,
Git, non-executing pass/block fixtures, and the managed configuration. It does
not prove that a running agent has loaded or trusted the hook. Calling `doctor`
without an agent lists all four; missing optional integrations are informational.

Claude/Codex hooks match `Bash`. OpenCode intercepts `bash` before execution.
Antigravity matches `run_command`; its adapter has protocol tests, but live IDE
enforcement and silent-pass behavior remain unverified.

## Updates and removal

Repeat the npm installation command with the new package, then run the appropriate
`nomeatproxy install <agent>` command again. This refreshes executable paths if the
Node installation or npm prefix changed. Restart the agent so it loads the new code.
Windows Codex/Antigravity hooks also need `node` on the agent's PATH.

Remove integrations **before** removing the package:

```sh
nomeatproxy uninstall claude
# Repeat for any other agents you installed.
npm uninstall --global nomeatproxy
```

Use `--project` in each project where you installed a project hook. Uninstall
removes only entries marked by this installer, preserves unrelated configuration,
and backs up files it changes. Manually installed hooks need manual removal.
Do not configure both global and project copies unless you want both to run.

## Platforms

The portable npm artifact contains JavaScript, declarations, and documentation.
It excludes locally built native executables, development fixtures, and local
benchmark reports. CI exercises installation and tests on macOS, Linux, and
Windows with Node 22 and 24.

**Package installation is separate from command coverage.** The engine currently
parses selected POSIX shell commands. PowerShell and cmd.exe deletion syntax,
Windows-specific shell/path translation, and arbitrary scripts are not fully
inspected. A native Windows installation does not imply protection for those
operations. Use WSL with Node, Git, the agent, and NoMeatProxy installed inside
the same WSL environment for the POSIX workflow.

The resident Unix-socket transport is macOS/Linux only. Live agent tests are
documented separately in [compatibility](COMPATIBILITY.md).

## Manual configuration

If you prefer to review and merge a fragment yourself:

```sh
nomeatproxy config claude --workspace /absolute/path/to/your/project
nomeatproxy config codex --workspace /absolute/path/to/your/project
nomeatproxy config antigravity --workspace /absolute/path/to/your/project
```

`config` prints JSON without changing settings. Antigravity uses named top-level
hooks, a different schema from Claude/Codex. These manually installed fragments
are not owned by `uninstall`.

OpenCode's managed local plugin imports the installed adapter through a file URL.
For a manual plugin, re-export `NoMeatProxyPlugin` from the installed
`dist/adapters/opencode.js`. It throws on a denial; other tools are outside its scope.

## Optional fast transport

A small native client calls a resident checker over a private Unix socket,
avoiding Node startup on every tool call. It uses the same policy engine and
does not cache permissions. Build this optional client from a checkout with
**Go 1.22+** on macOS or Linux:

```sh
npm ci
npm run build:native

# Keep this running in a separate terminal.
node dist/cli.js serve
```

Generate the desired agent's fragment from that checkout:

```sh
node dist/cli.js config claude --transport resident --workspace /absolute/path/to/your/project
```

Merge it manually into the agent settings. If switching an existing managed hook,
remove that hook with `nomeatproxy uninstall claude` first to avoid duplicate checks.
The ordinary `install` command always configures the portable Node transport.

The default socket is `~/.nomeatproxy/run/guard.sock`. Both commands also accept
`--socket /absolute/path/to/private-directory/guard.sock`. The directory must be
owned by the current user with mode 0700; the service creates a missing directory.

The client blocks when the checker is absent, stalls, or returns invalid output.
Restart the checker after rebuilding or changing policy. Ctrl-C stops it and
removes the listening socket. After an abrupt crash, inspect any remaining socket
before removing it; the service will not overwrite an existing endpoint.

The native routine path measured **9.2 ms p95**, including fresh client startup
and the round trip; the direct Node CLI measured **88.7 ms**. This excludes agent
scheduling. See [measurements](BENCHMARKS.md).

## Generic callers

`nomeatproxy hook --agent generic` accepts JSON on stdin, exits 2 to block, and
puts the explanation on stderr. A caller must explicitly honor that contract.

## Development

```sh
npm ci
npm run check         # typecheck, build, behavior and setup tests
npm run test:package  # pack, install in a temp prefix, exercise the actual CLI
npm run bench         # engine and CLI timings
npm run evaluate      # labeled corpus, including documented gaps
npm run test:native   # build and test optional transport, on macOS/Linux
```

Package smoke tests install with lifecycle scripts disabled, verifying that
tarball consumers need no compiler. All setup tests use temporary directories;
they do not change your real agent configurations. Native integration tests
run when the binary exists; otherwise they are explicitly skipped.

[Design](DESIGN.md) · [Roadmap](ROADMAP.md) · [Compatibility](COMPATIBILITY.md)

No telemetry, model calls, cloud calls, automatic approval grants, or execution
of checked commands. Selected destructive operations use bounded read-only Git
subprocesses. MIT; shell parsing is adapted from PlanSentry. See [NOTICE](../NOTICE).
