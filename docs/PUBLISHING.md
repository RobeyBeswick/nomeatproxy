# Publishing checklist

Handoff prepared 2026-10-29. Suggested first public version: **0.1.0**, described
as a prototype. Work through this checklist from a personal release machine.
The handoff itself does not publish a package or change repository visibility.

## Current state

| Area | Status |
| --- | --- |
| Source | `chore/public-launch`, release-preparation changes based on `main` |
| Package | `0.1.0`, publishing enabled in the release branch |
| GitHub | Repository is private; no release or version tag exists |
| npm | Package returned 404 on 2026-10-29; this release machine is not logged in to npm |
| CI | Latest `Check` run did not start its jobs because of a billing/spending-limit block |
| Live compatibility | OpenCode 1.19.5 verified 2026-10-29; Claude Code 2.1.295 and Codex 0.162.0 remain tested 2026-10-09; Antigravity is adapter-only |
| Public-content review | Gitleaks and Actions-log scans clean; artifact inspected; visual sampling every 2 seconds found only scripted demo content; audio review and signed-out link review remain |

Local verification on 2026-10-29 passed on `chore/public-launch` with Node.js
22.23.4, npm 10.9.9, and Go installed:

- `npm ci`, `npm run check` (80 passed, 6 native tests skipped pending the separate native run), and all eight native-transport tests.
- Packed-package installation test: 34 files, approximately 42 KiB compressed.
- Evaluation corpus: 16 benign cases, 17 covered hazards, and three explicit coverage gaps.
- `npm run demo -- --auto` and `npm pack --dry-run`; packed files exclude local reports, fixtures, native binaries, and the demo video.
- `npm audit`: zero reported vulnerabilities. `npm outdated` found no newer compatible versions; `npm update` made no dependency changes.
- `gitleaks git --redact .`: seven commits scanned, no leaks found.

Rerun verification on the exact final `main` commit. Gitleaks does not replace
the remaining audio and signed-out link review.

## 1. Set up the personal laptop

- [x] Install Git, Node.js 22 or 24 with npm, and the GitHub CLI.
- [x] Authenticate the GitHub CLI with an account that can access this private
  repository. Run `gh auth login` if needed, then clone:

```sh
gh repo clone RobeyBeswick/nomeatproxy
cd nomeatproxy
git status --short --branch
npm ci
```

- [x] Install Go if validating the optional native transport. The standard npm
  package does not require Go; see [setup](SETUP.md#optional-fast-transport).
- [x] Install and authenticate any agent clients used for live compatibility
  checks. Do not copy credentials or agent settings into this repository.
- [ ] Confirm access to the npm account that will own the package:

```sh
npm login
npm whoami
npm view nomeatproxy name version --registry=https://registry.npmjs.org/
```

An npm 404 means the package was not found; it does not reserve the name or
guarantee that publishing will succeed. If the name is unavailable, settle the
package name and update documentation and packaging tests before continuing.

## 2. Finish the public-content review

- [x] Run a history-aware secret scan, for example `gitleaks git --redact .`
  after installing Gitleaks, and inspect any findings.
- [x] Review tracked files and commit metadata for personal paths, internal
  URLs, account IDs, customer details, and secrets. Keep scan reports private.
- [ ] Watch `docs/assets/nomeatproxy-video.mov` and inspect the embedded README
  video for private terminal content, notifications, paths, and identifiers.
- [x] Review existing Actions logs and artifacts before changing visibility;
  they can become publicly accessible with the repository.
- [ ] Check links as an outside reader. The PlanSentry source repository remains
  private; its source availability is clarified in `NOTICE`. Preserve the
  copyright and license attribution. This release does not require making
  another repository public.

Remove sensitive material from history as well as the current checkout if any
is found, and rotate exposed credentials before publishing.

## 3. Prepare the version and dependencies

```sh
git switch -c chore/public-launch
npm pkg delete private
npm version 0.1.0 --no-git-tag-version
npm outdated
npm update
npm audit
git diff -- package.json package-lock.json
```

`npm outdated` can exit nonzero when it finds newer versions. Review the output
before continuing; do not treat every newer major as required release work.

- [x] Confirm `package.json` and `package-lock.json` both report `0.1.0`, with
  publishing enabled.
- [x] Review dependency changes and commit the lockfile.
- [x] Keep Node types aligned with the minimum supported runtime.
- [x] If changing the supported Node versions, update `engines`, documentation,
  and the CI matrix together.

The handoff baseline uses TypeScript `5.9.3` and locked Node types `22.20.5`.
There are no production npm dependencies or external Go module dependencies.
No audit finding required a dependency upgrade during the previous review.
Avoid combining the first release with an unnecessary compiler major migration.

The workflow currently uses `v4` of checkout, setup-node, and upload-artifact.
Review their current upstream guidance if updating them, and require the full
matrix to pass. Action modernization can follow the first release.

## 4. Prepare the release documentation

- [x] Update the quickstart in [README](../README.md) and [setup](SETUP.md) to
  use the registry installation below when the package is published.
- [x] Update retained tarball examples from `0.0.1` to `0.1.0`.
- [x] Add a root `CHANGELOG.md` entry for `0.1.0`, including supported operations,
  agent integrations, installation, and known limitations.
- [ ] Add a root `SECURITY.md` with a working private reporting route. Configure
  that route before advertising it.
- [x] Keep the prototype label, POSIX-shell coverage limits, and Antigravity's
  experimental status unless fresh evidence supports changing them.
- [x] Keep benchmark claims tied to their measured runtime and transport.
  The advertised native/resident timing is not the default Node CLI timing.
- [ ] Update the npm milestone in [roadmap](ROADMAP.md) after publication succeeds.

The intended public quickstart is:

```sh
npm install --global nomeatproxy
nomeatproxy install claude
nomeatproxy doctor claude
```

Retain agent restart instructions and the documented hook review/trust step for
Codex. Stage these documentation changes before packing so the npm README matches
the release; announce registry availability only after publication succeeds.

## 5. Refresh live compatibility evidence

With installed, authenticated clients:

```sh
npm run build
node scripts/compat.mjs claude
node scripts/compat.mjs codex
node scripts/compat.mjs opencode
```

- [x] Verify each advertised integration observes the allowed control, blocks
  the disposable deletion canary, and preserves the sentinel.
- [x] Record actual client versions, test date, mode, and results in
  [compatibility](COMPATIBILITY.md).
- [x] Sanitize any results copied to `docs/compatibility.local.json`; keep raw
  transcripts, temporary paths, and authentication details out of Git.
- [x] If a client cannot be validated, state the older tested version or narrow
  the launch claim. Do not label an inconclusive run as a pass.
- [x] Leave Antigravity experimental unless live enforcement is validated.

The harness invokes real clients and can consume their configured model usage.
Its requests target a disposable test fixture. Follow the full scope and limits
in the compatibility document.

## 6. Verify and commit the release candidate

```sh
npm ci
npm run check
npm run test:package
npm run evaluate
npm run demo -- --auto
npm run test:native
npm pack --dry-run
git diff --check
git status --short
```

Run `test:native` on macOS/Linux with Go installed. If the optional transport is
not tested on this machine, retain the earlier dated evidence and do not claim
it was freshly validated.

- [x] All applicable local checks pass.
- [x] Inspect the package file list: compiled JavaScript, declarations,
  documentation, and licensing are present; secrets, local reports, fixtures,
  native binaries, and the demo video are absent.
- [x] Review and commit release changes with a conventional commit message.
  Stage specific intended files rather than generated reports or credentials.
- [ ] Push the branch and merge through a reviewed pull request:

```sh
git push -u origin chore/public-launch
```

- [ ] Resolve the Actions billing/spending-limit block and obtain a successful
  `Check` run for the final release commit. All six combinations of macOS,
  Linux, Windows, and Node 22/24 should pass.

If changing visibility before rerunning CI is necessary, complete the public
review first. Still require passing CI before publishing the package or post.

## 7. Make the source public and build the final tarball

- [ ] In GitHub repository settings, use **General → Danger Zone → Change
  visibility → Public** when ready to expose the reviewed source and history.
- [ ] Check the repository, README, embedded video, and documentation links in a
  signed-out browser.
- [ ] After the release branch is merged, use the exact verified commit on main:

```sh
git switch main
git pull --ff-only
git status --short
git rev-parse HEAD
npm ci
npm run test:package
npm pack
```

- [ ] Confirm the working tree is clean, record the release commit, and inspect
  `nomeatproxy-0.1.0.tgz`. Publish from this checkout without changing its contents.
- [ ] Use a GitHub Release attachment for the public tarball download, and
  update setup instructions that currently point readers at Actions artifacts.

## 8. Publish npm and create the GitHub Release

These commands perform the actual release. Run them only after the preceding
checks are complete and with npm publishing authentication ready.

```sh
npm publish ./nomeatproxy-0.1.0.tgz --dry-run
npm publish ./nomeatproxy-0.1.0.tgz --access public
npm view nomeatproxy@0.1.0 version dist-tags
```

- [ ] Confirm version `0.1.0` is available and the intended `latest` tag points
  to it.
- [ ] Tag the same recorded release commit and push the tag:

```sh
git tag -a v0.1.0 -m "NoMeatProxy 0.1.0"
git push origin v0.1.0
```

- [ ] Create a GitHub Release for `v0.1.0`, attach the same
  `nomeatproxy-0.1.0.tgz`, and include the changelog and prototype limitations.
  For example, after preparing and reviewing a release-notes file:

```sh
gh release create v0.1.0 ./nomeatproxy-0.1.0.tgz \
  --verify-tag --title "NoMeatProxy 0.1.0" \
  --notes-file /path/to/release-notes.md
```

If a release command fails, inspect what was actually published before retrying.
Do not overwrite tags or assume an already published npm version can be replaced.

## 9. Test the public installation, then post

Use a clean environment outside the source checkout:

```sh
npm install --global nomeatproxy@0.1.0
nomeatproxy --version
nomeatproxy install claude
nomeatproxy doctor claude
nomeatproxy check "git status --short"
nomeatproxy check "rm -rf /"
```

The final two commands inspect strings; they do not execute them. The last
command should block and return a nonzero exit status.

- [ ] Verify the CLI reports `0.1.0`, restart the agent, and check its hook
  diagnostics.
- [ ] Validate a live allow/block canary in a disposable workspace using the
  installed package, not an adapter imported from this source checkout.
- [ ] Confirm uninstall removes the managed integration.
- [ ] Check that the unversioned public quickstart installs the intended release.
- [ ] Mark the npm roadmap milestone complete and remove remaining
  "not published yet" wording.
- [ ] Publish the post with the public repository, npm installation command,
  and working demo. Describe it as a local accident guard for selected shell
  operations, with claims matching the recorded compatibility evidence.

## Follow-up work that does not block the prototype launch

- Automated trusted npm publishing and release workflows.
- Homebrew distribution.
- Compiler and GitHub Actions major upgrades after validation.
- Broader command coverage, representative session evaluation, and more live
  agent/platform coverage.
- Supervised lifecycle for the optional resident transport.

Track product work in [roadmap](ROADMAP.md); keep this checklist focused on
publication and release verification.
