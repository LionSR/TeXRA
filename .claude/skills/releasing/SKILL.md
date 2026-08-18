---
name: releasing
description: Cut a TeXRA release — changelog, tags, GitHub Releases, and the desktop installer dispatch. Use when publishing a new version, cutting release tags, writing changelog entries for a release, or debugging the release/publish workflows.
---

# Releasing TeXRA

TeXRA ships three release tracks off the same commit, with identical
user-facing notes. Publishing is CI-driven
(`.github/workflows/release.yml`, fired by `release: published`) — the manual
steps are only: update the changelog, cut two tags, and create two GitHub
Releases. No local `vsce` / `ovsx` / `npm publish` invocation and no OTP.

## Steps

1. **Changelog.** Move `[Unreleased]` content into a new dated
   `## [X.Y.Z] - YYYY-MM-DD` section, folding in anything that accumulated
   since a prior draft that never shipped. Commit and push to `main`.

2. **Tags.** Cut both off that commit and push:

   ```bash
   git tag vX.Y.Z <sha> && git tag cli-vX.Y.Z <sha>
   git push origin vX.Y.Z cli-vX.Y.Z
   ```

3. **GitHub Releases.** Create two, body = the changelog section for that
   version (extract with e.g.
   `awk '/^## \[X.Y.Z\]/{f=1} /^## \[PREV\]/{f=0} f' CHANGELOG.md`):

   - `gh release create vX.Y.Z --title vX.Y.Z --notes-file <notes>` — triggers
     `publish-extension`: builds the VSIX (`pnpm --filter texra build:fast`)
     and publishes to the VS Code Marketplace and Open VSX via stored PATs
     (`VSCE_PAT` / `OVSX_PAT`, `skipDuplicate: true`).
   - `gh release create cli-vX.Y.Z --title cli-vX.Y.Z --notes-file <notes>` —
     triggers `publish-cli`: `npm publish` from `packages/cli` over npm Trusted
     Publishing (OIDC `id-token: write`), so it runs unattended in CI.

4. **Desktop.** `.github/workflows/desktop-package.yml` is
   `workflow_dispatch`-only (**not** release-triggered). Build signed
   macOS/Linux/Windows installers and publish them to the public
   `texra-ai/texra-desktop-releases` repo by dispatching it with
   `run_desktop_installers`, `run_windows_desktop`,
   `require_desktop_signing`, and `publish_desktop_release_artifacts` all
   `true`.

5. **`llm-zoo` pin.** If the release changes `llm-zoo`, also update the exact
   pin in `supabase/functions/log-usage/deno.json`, then refresh its adjacent
   `deno.lock` file. (The relay's own `attic/supabase-relay/functions/relay/deno.json`
   pin is retired and no longer deployed — see
   `docs/proposals/2026-08-18-relay-removal-and-recovery.md`.) This is called
   out in the `version-bump.yml` PR body but is easy to miss, since it isn't
   part of the automated bump.

## Gotchas

- **Both publish jobs assert the release tag matches the corresponding
  `package.json` version and fail closed if it doesn't.** Cut the tags only
  after that manifest version is actually on `main`.

- **`version-bump.yml` is gated to the plain `vX.Y.Z` tag only**, so it doesn't
  double-fire off the `cli-` tag. It opens a PR bumping every package manifest
  to the next dev version; that PR does **not** touch `CHANGELOG.md`.

- **Re-running an abandoned release.** If a tag/release for a version was
  created previously but the workflow never ran, re-running
  `gh release create` reuses the existing tag — pass no `--target` (an explicit
  `--target` on a tag that already has a commit 422s).

## Changelog content rules

Focus on user-visible changes. Full rules in AGENTS.md "Changelog Guidelines";
the ones most often gotten wrong:

- Describe the net difference from the previous released version, not the
  sequence of commits made during development.
- Never document defects introduced and fixed before the release — intermediate
  implementation states are not release changes.
- Don't expose internal architecture, protocol names, schemas, or codenames;
  describe the effect in product terms.
- Exclude refactors, tests, and dependency maintenance with no user-visible
  effect.
