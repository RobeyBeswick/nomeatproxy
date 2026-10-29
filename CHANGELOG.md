# Changelog

## 0.1.0 — Prototype

First public prototype release.

- Inspect selected POSIX-shell file and Git operations before an integrated agent
  runs them, including risky deletion/restoration of protected or locally changed
  files and remote history rewrites.
- Integrations are available for Claude Code, Codex, and OpenCode. Live canary
  results and tested client versions are recorded in
  [compatibility](docs/COMPATIBILITY.md). Antigravity support remains experimental;
  live enforcement has not been verified.
- Install with `npm install --global nomeatproxy` (Node.js 22+ and Git required),
  then run `nomeatproxy install <agent>` and restart the agent. Codex users must
  review and trust the hook through `/hooks`.

### Limitations

NoMeatProxy is a local accident guard, not a sandbox or a security boundary against
a malicious agent. It does not execute checked commands, and it does not inspect
all ways to change files or affect remote systems. Coverage is limited to selected
POSIX shell operations; arbitrary scripts, unsupported wrappers, PowerShell, and
cmd.exe operations may pass without inspection. A passing check means only that no
implemented rule blocked that command. See the [design](docs/DESIGN.md) and
[compatibility notes](docs/COMPATIBILITY.md) for scope and evidence.
