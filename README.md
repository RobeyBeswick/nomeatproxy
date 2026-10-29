<a id="top"></a>

# NoMeatProxy: stop being your agent’s meat proxy

<div align="center">

[![Claude Code Hook](https://img.shields.io/badge/Claude_Code-Hook-6272F5)](#agents)
[![Codex Hook](https://img.shields.io/badge/Codex-Hook-10A37F)](#agents)
[![OpenCode Plugin](https://img.shields.io/badge/OpenCode-Plugin-18181B)](#agents)
[![Antigravity Experimental](https://img.shields.io/badge/Antigravity-Experimental-FBBC04)](#agents)
[![Status: Prototype](https://img.shields.io/badge/Status-Prototype-orange)](docs/ROADMAP.md)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

</div>

> **meat proxy** · *noun*<br>
> A carbon-based peripheral that clicks “Allow” for an AI.

You wanted an autonomous agent. Somehow you became its full-time approval button.

NoMeatProxy is a local safety hook for coding agents running with broad permissions.
It checks supported shell actions before they run and catches things like deleting
uncommitted work, wiping a protected directory, or force-pushing over remote history.

**“I’ll just clean that up” should not be the last thing your files hear.**

### Let It Cook.

Routine commands pass quietly. The ordinary check needs no second model, no network
trip, and no fresh opportunity for you to click “yes, still yes”.

### Look at What Could Be Lost.

File and Git checks inspect the target and local state. An ignored database still
contains data. A staged edit may already have a preserved copy. The details matter.

### Stop With Receipts.

A block shows the target, the risk, and the evidence. You get something concrete to
review when it’s time to step in.

---

[Quick Start](#quickstart) • [Demo](#demo) • [How It Works](#how-it-works) • [What It Catches](#what-it-catches) • [Agents](#agents) • [FAQ](#faq)

---

<a id="quickstart"></a>

## ⚡ Quickstart

Requires **Node.js 22+** and **Git**. No model subscription for the guard.
No Go compiler for the standard installation. Your finger may now leave the approval button.

Install from npm:

```sh
npm install --global nomeatproxy
nomeatproxy install claude
nomeatproxy doctor claude
```

For prebuilt packages and other installation options, see the
[installation guide](docs/SETUP.md).

Pick your agent:

```sh
nomeatproxy install claude
nomeatproxy install codex
nomeatproxy install opencode
nomeatproxy install antigravity
```

Run the line for the agent you use, then restart it. **Codex also requires hook
review/trust through `/hooks`.** Antigravity support remains experimental.

The installer merges into your user settings and backs up files it changes.
Add `--project` to install only in the current project. It leaves your other hooks
alone. `doctor` checks local setup; the agent's diagnostics confirm that it actually
loaded and trusted the hook.

Take it for a spin:

```sh
nomeatproxy check "git status --short"
nomeatproxy check "rm -rf /"
```

**These commands only inspect the quoted strings. They do not execute them.**
The first passes; the second is blocked with a reason.

The npm package targets macOS, Linux, and Windows. **Shell inspection currently
covers POSIX syntax; PowerShell and cmd.exe operations are outside its coverage.**
On Windows, use WSL for the POSIX workflow. Packaging tests and live agent coverage
are separate; see [platform details](docs/SETUP.md#platforms).

Changed your mind? `nomeatproxy uninstall claude` removes the managed hook.
The [setup guide](docs/SETUP.md) covers updates, manual configuration, and the optional
faster hook transport. Homebrew distribution is not published yet.

<a id="demo"></a>

## 🎬 Demo

https://github.com/user-attachments/assets/b013d012-d3b3-4b5c-8163-b9f8041cd38a

[Download the MOV](docs/assets/nomeatproxy-video.mov)

Run the repeatable walkthrough from a checkout:

```sh
npm ci
npm run demo
```

Press **Enter** to advance through five real hook checks: routine work, an
uncommitted edit, the same restore after staging, ignored data, and a force push.
The demo uses a temporary Git repository and scripted requests; proposed commands
are inspected, never executed. No live agent or published npm package is needed.

Run all scenes without pauses: `npm run demo -- --auto`.

The agent decides the quickest way to “fix the branch” is:

```text
git push --force origin main
```

NoMeatProxy intervenes. An excerpt from the block:

```text
NoMeatProxy stopped this tool call.

[git.remote-history] This push can rewrite or delete remote history.
  Target: "origin"
  Target: "main"
  Evidence: "Force, deletion, or mirror semantics were requested; remote ownership has not been established."
```

The blocked push does not run. An intentional history rewrite goes to a human for
review and execution. Meanwhile, `git status`, searches, and a normal push can carry on.

<a id="how-it-works"></a>

## 🔎 How It Works

1. **Catch the pending shell call.** An agent hook or plugin hands the command to NoMeatProxy before execution.
2. **Inspect the relevant state.** Resolve deletion targets, check Git work, or preview a cleanup with a dry run.
3. **Pass quietly or block with evidence.** Supported destructive actions get held when the checks find a risk or cannot establish their target.

The current release checks selected file and Git operations. It does not execute the
submitted command, call another model, or send your commands to a cloud service.

<a id="what-it-catches"></a>

## 🥩 What It Catches

| | Examples | What happens |
|---|---|---|
| 🔴 **Protected paths** | `rm` targeting `/`, your workspace root, `.git`, credential directories, or paths outside the workspace | Stops |
| 🔴 **Work you could lose** | Deleting modified, untracked, or ignored files; Git operations that would discard local work | Stops with evidence |
| 🔴 **Remote history surgery** | Force pushes, mirror pushes, and remote branch deletion | Stops for human review |
| 🟡 **Unclear deletion targets** | Variables, globs, or an unresolved working directory in an `rm` command | Holds instead of guessing |
| 🟢 **Routine work** | Status checks, searches, normal pushes, and supported restores that preserve the affected work | Passes quietly |
| ⚪ **Outside current coverage** | Effects inside arbitrary scripts, task runners, cloud commands, and other unsupported tools | May pass without inspection |

Path-specific restore and checkout checks ignore unrelated edits. Hard resets and
forced branch switches are still more conservative. The [design](docs/DESIGN.md)
spells out the current boundaries.

<a id="agents"></a>

## 🤝 Bring Your Agent

| Agent | Integration | Current status |
|---|---|---|
| **Claude Code** | Pre-tool hook | Live allow/block test passed with `--dangerously-skip-permissions` |
| **Codex** | Pre-tool hook | Live allow/block test passed with approvals and sandboxing bypassed |
| **OpenCode** | Plugin | Live allow/block test passed with `--auto` |
| **Antigravity** | Pre-tool hook | Adapter tests pass; live validation pending |

Those live tests allowed a harmless command, then blocked deletion of a disposable
untracked file. They cover the tested shell path, not every action an agent can take.
[Setup instructions](docs/SETUP.md) · [Versions and test details](docs/COMPATIBILITY.md)

<a id="faq"></a>

## ℹ️ FAQ

**Q: Will it turn every command into a committee meeting?**

That’s the problem it’s here to reduce. Checks run locally. The optional fast hook
path measured **9.2 ms p95** on the current benchmark, including client startup;
the direct Node CLI measured **88.7 ms**. Agent scheduling is extra. See the
[measurements](docs/BENCHMARKS.md) and [fast setup](docs/SETUP.md#optional-fast-transport).

**Q: So I can YOLO absolutely everything now?**

It catches specific mistakes on supported paths. Arbitrary scripts, redirections,
heredocs, Git aliases/hooks, native file-editing tools, and cloud effects are not
fully covered. A pass means no implemented rule blocked the command. Some unsupported
operations pass through. The [roadmap](docs/ROADMAP.md) tracks the gaps.

**Q: Can the agent approve its own bad idea?**

There is no self-approval command. For now, a human reviews and performs an intentional
blocked operation outside the agent. A protected approval flow is planned.

**Q: Will it ever be too cautious?**

Yes. It’s a prototype. Ignored files aren’t assumed disposable, and some Git checks
still inspect the whole worktree. If it blocks a legitimate cleanup, the exact command
and Git state make a useful regression case. Being ignored by Git is a poor backup strategy.

**Q: Can it stop a malicious agent?**

No. This is an accident guard, not a sandbox. An agent with the same OS access can
change its own hooks or take a path that isn’t intercepted. Keep credentials and
permissions scoped to the work.

**Q: Is this related to PlanSentry?**

Yes. It builds on PlanSentry’s approach: inspect the consequences and show why an
operation needs a human. PlanSentry integration is planned; infrastructure protection
is not included in NoMeatProxy yet. Some shell parsing code is adapted from PlanSentry;
its source repository is private and is not required to use NoMeatProxy. See [NOTICE](NOTICE).

<a id="contributing"></a>

## 🛠️ Help Retire the Meat Proxy

Useful contributions: a command that slipped through, a harmless command that got
blocked, or an agent integration we haven’t checked. Include a small reproduction
with secrets removed.

```bash
npm run check       # typecheck, build, and behavior tests
npm run test:package # install and exercise the packed npm artifact
npm run evaluate    # labeled examples, including known coverage gaps
npm run bench       # measure engine and hook overhead
```

[Design](docs/DESIGN.md) · [Roadmap](docs/ROADMAP.md) · [Developer setup](docs/SETUP.md#development) · [Publishing checklist](docs/PUBLISHING.md)

## 📄 License

**MIT.** Shell parsing code is adapted from PlanSentry; see [NOTICE](NOTICE).

---

<p align="center">
  <a href="#top"><strong>Back to the top. No approval required.</strong></a>
</p>
