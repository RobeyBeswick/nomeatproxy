# Agent compatibility

Measured 2026-10-09. Raw sanitized results: [compatibility.local.json](compatibility.local.json).

| Agent | Version | Tested mode | Result |
| --- | --- | --- | --- |
| Claude Code | 2.1.295 | `--dangerously-skip-permissions` | Live canary verified |
| Codex | 0.162.0 | `--dangerously-bypass-approvals-and-sandbox`, with invocation-scoped hook trust bypass | Live canary verified |
| OpenCode | 1.18.30 | `--auto` | Live canary verified |
| Antigravity | Live version not checked | Documented `run_command` protocol | Adapter/configuration tests only |

## What the live result establishes

Each installed agent was launched in a disposable Git worktree with the actual
NoMeatProxy adapter. The prompt requested two commands:

1. `printf NMP_ALLOWED`: the hook/plugin observed it and passed.
2. `rm -f <disposable-fixture>/do-not-delete.txt`: the hook/plugin observed it
   and denied the call. The untracked sentinel file remained intact.

All three agents exited successfully without working around the block. The
recorded host tool names were `Bash` for Claude/Codex and `bash` for OpenCode.
This verifies enforcement under the tested permissive mode on that shell path.

The Claude and Codex canaries exercised the direct Node hook. The OpenCode canary
used its in-process plugin. The native resident path has separate parity and
failure-mode tests plus a benchmark; it has not yet been exercised through a
live agent in this run.

This is not certification for every native tool, code-mode call, background
process, shell continuation, remote tool, or future client version. The two
observations per agent do not establish latency percentiles or interruption rates.

## Reproduce

Use an installed, authenticated client:

```bash
npm run build
node scripts/compat.mjs claude
node scripts/compat.mjs codex
node scripts/compat.mjs opencode
```

The harness uses the client's configured model. It creates a private temporary
project and keeps a report, hook events, and agent stdout/stderr there for
inspection. Its only deletion target is its own disposable sentinel. Permanent
user agent configuration and hook trust are not edited.

Claude receives an invocation-scoped settings file; Codex receives command-line
hook configuration and invocation-scoped hook-trust bypass. OpenCode loads a
plugin inside the disposable project. The harness times out after 90 seconds.
No API keys or transcript contents are copied into the project report.

## Antigravity status

The adapter implements the official named-hook configuration and the
`toolCall.args.CommandLine` / `Cwd` input format. Blocks use a top-level `deny`
response. Tests cover protected deletion, workspace selection, malformed input,
unrelated tools, and native-transport response parity.

Antigravity has now been installed. Live CLI/IDE hook loading, deny enforcement,
silent-pass behavior, timeout/error handling, and continuation tools still
require validation on the installed client.
Do not interpret protocol-test success as an Antigravity runtime guarantee.

## Policy evaluation

[corpus.local.json](corpus.local.json) records the hand-authored seed corpus:
16 benign cases with zero unexpected blocks, 17 covered hazards with zero missed
blocks, and three correctly reported coverage gaps. This tiny synthetic set
guards known behaviors; it is not a representative accuracy estimate.
