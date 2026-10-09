# Roadmap

## 0. Working design prototype — this checkout

- [x] Separate project, typed inspector interface, non-executing CLI.
- [x] Local filesystem and Git checks with bounded read-only probes.
- [x] Claude/Codex hook protocol adapters and OpenCode plugin adapter.
- [x] Behavior tests with real temporary Git repositories.
- [x] Engine and full CLI-startup benchmark.
- [x] Explicit threat model, coverage gaps, and approval design.

This milestone is for developing and evaluating the product. It is not a
production safety certification.

## 1. A quiet, credible daily-use release

- [x] Seed a labeled corpus with 16 benign cases, 17 covered hazards, and three
  explicit coverage gaps. Evaluation is repeatable and does not execute commands.
- [ ] Expand the seed corpus with representative ordinary coding sessions and
  real mistake reports.
- [ ] Measure missed covered hazards and unwanted interruptions per 1,000 tool
  calls; do not report broad accuracy without identifying coverage.
- [x] Scope restore and explicit-path checkout to actual Git pathspecs, accounting
  for staged versus unstaged content.
- [ ] Narrow hard reset and forced branch-switch checks without missing untracked
  or ignored obstructions.
- [ ] Add explicit human-owned disposable-path policy, with protected-path
  precedence and no implicit trust in names like `dist`.
- [ ] Detect unsupported wrappers without silently overstating inspection.
- [ ] Expand coverage to file writes/redirections and selected task-runner paths.
- [ ] Add safe installation/uninstallation with settings merge, backup, hook
  discovery, and a harmless compatibility self-test.
- [x] Verify a live allow/block canary in Claude bypass mode, Codex permissive
  mode, and OpenCode auto mode. Versions and exact test scope are recorded.
- [x] Add Antigravity's documented payload/decision/configuration adapter.
- [ ] Validate Antigravity CLI and IDE with an installed, authenticated client.
- [x] Meet the local routine p95 target with an optional native launcher and
  resident checker; test unavailable service, timeout, bad replies, and concurrency.
- [ ] Measure the 50 ms routine hook p95 target inside the actual agents, including
  scheduling and sustained mixed load.
- [ ] Add supervised resident-service lifecycle and policy-reload diagnostics.

Exit criteria: a documented compatibility matrix, measured latency and
interruption rate, transparent unsupported paths, and repeatable safety tests.

## 2. Infrastructure and approval

- [ ] Define a structured PlanSentry inspector contract.
- [ ] Bind approval/execution to the checked artifact and concrete cloud target.
- [ ] Build a human-owned approval service with single-use expiring grants.
- [ ] Prevent the agent from minting or widening its own approval.
- [ ] Add protected execution for supported dangerous actions.

## 3. Broader consequences

- [ ] Database mutations with transaction/dry-run/backup evidence where supported.
- [ ] Secret exposure through outbound requests, Git publication, and tool calls.
- [ ] Protected cloud resources and narrowly scoped credentials.
- [ ] Explicit budgets for expensive resource creation.
- [ ] Optional semantic review for ambiguity, with measured cost and latency.

Each inspector ships with its own scope, evidence model, failure behavior,
latency budget, benign near-matches, and adversarial regression fixtures.
