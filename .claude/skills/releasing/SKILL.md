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
Stable releases follow the steps below; a preview (`X.Y.Z-preview.N`) follows
"Preview releases" further down and never touches the stable channel.

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
   `texra-ai/texra-desktop-releases` repo by dispatching it on the tagged
   commit with `run_desktop_installers`, `run_windows_desktop`,
   `require_desktop_signing`, and `publish_desktop_release_artifacts` all
   `true`, **and `release_tag` = `vX.Y.Z`**. The publish step fails closed on
   an empty `release_tag`, and on one that does not match
   `packages/desktop/package.json`, for every dispatch, stable as well as
   preview.

5. **`llm-zoo` pin.** If the release changes `llm-zoo`, also update the exact
   pin in `supabase/functions/log-usage/deno.json`, then refresh its adjacent
   `deno.lock` file. It is easy to miss, since it isn't part of the automated
   bump.

## Preview releases

A preview is the same three tracks on a second channel that existing users
never receive unless they opt in. Both publish jobs decide the channel from the
package version **and** the GitHub pre-release flag, and fail closed when the
two disagree, so a preview cannot land on stable by a missing flag.

- **Version scheme:** `X.Y.Z-preview.N`, N from 1. It is the one prerelease
  form the bump script and the workflows accept (`-beta`, `-rc` are rejected).
  Tags follow the stable pair: `vX.Y.Z-preview.N` and `cli-vX.Y.Z-preview.N`.
- **Marketplace numbering rule:** the VS Code Marketplace refuses semver
  suffixes and tells pre-release from stable only by version order and the
  `--pre-release` stamp, so a preview is cut for the `.0` of an **even-minor**
  train and `publish-extension` packages it as the bare `X.(Y+1).N`
  pre-release (`v1.0.0-preview.3` publishes as `1.1.3`, pre-release). From
  1.0 on, stable extension trains use even minor numbers (1.0, 1.2, ...); the
  job refuses an odd-minor stable tag and a preview of a `.Z ≠ 0` or odd-minor
  version. Only the VSIX is renumbered; npm and the desktop installers carry
  `X.Y.Z-preview.N` as-is.
- **CLI:** `publish-cli` runs `npm publish --tag preview` for a preview version
  and `--tag latest` for a stable one, never the implicit default. Users opt in
  with `npm install -g @texra-ai/cli@preview`.
- **Desktop:** the same `desktop-package.yml` dispatch, with `release_tag` set
  to `vX.Y.Z-preview.N`. The publish step creates the release in
  `texra-ai/texra-desktop-releases` marked pre-release, and refuses to attach
  installers to an existing release whose pre-release flag disagrees with the
  version, to a tag that does not match `packages/desktop/package.json`, or
  when `DESKTOP_RELEASES_TOKEN` is unset.
- **No version bump:** `version-bump.yml` skips pre-releases, so the next
  preview number is set by hand (below).

Procedure:

1. Set the manifests and commit to `main`:
   `node scripts/bump-workspace-version.mjs --version X.Y.Z-preview.N` (or
   `--from vX.Y.Z-preview.(N-1)` to increment the previous one). The
   changelog keeps its `[Unreleased]` section; previews do not get a dated
   entry.
2. Tag both off that commit and push, as for a stable release.
3. Create both GitHub Releases with `--prerelease`; the notes are the current
   `[Unreleased]` section:

   ```bash
   gh release create vX.Y.Z-preview.N --prerelease --title vX.Y.Z-preview.N --notes-file <notes>
   gh release create cli-vX.Y.Z-preview.N --prerelease --title cli-vX.Y.Z-preview.N --notes-file <notes>
   ```

4. Dispatch `desktop-package.yml` on the tagged commit with the four booleans
   `true` and `release_tag` = `vX.Y.Z-preview.N`.

Verify on a throwaway tag before the first real preview of a train:

1. Push a commit whose manifests read `X.Y.0-preview.N` and cut only the
   `cli-v` tag and release, with `--prerelease`. In the `publish-cli` log the
   channel step must print `npm dist-tag preview`; then
   `npm view @texra-ai/cli dist-tags` must show `preview` at that version and
   `latest` unchanged.
2. Cut the `v` tag and release with `--prerelease`. The channel step must print
   the Marketplace number `X.(Y+1).N`, the VSIX must be named after it, and
   the Marketplace listing must show that version under "Pre-Release" with the
   stable listing untouched; Open VSX likewise.
3. Confirm `version-bump.yml` was skipped for the `v` tag (no
   `chore: bump version to ...` PR opened).
4. Recreate the `cli-v` release **without** `--prerelease` (`gh release delete`
   then create again) and confirm `publish-cli` fails at the channel step
   without publishing; delete the release and tag afterwards.
5. Dispatch `desktop-package.yml` with `release_tag` and confirm the
   `texra-ai/texra-desktop-releases` entry is marked pre-release.
6. `npm deprecate` / `npm dist-tag rm` and Marketplace unpublish are the only
   ways back for a published throwaway, so use a version number you are
   willing to burn (`N` high enough not to collide with a real preview).

## Gotchas

- **Both publish jobs assert the release tag matches the corresponding
  `package.json` version and fail closed if it doesn't.** Cut the tags only
  after that manifest version is actually on `main`.
- **Take the version `version-bump.yml` proposes as-is, including at the end
  of a patch train.** `nextWorkspaceVersion` in
  `scripts/bump-workspace-version.mjs` bumps the patch (`X.Y.Z` to
  `X.Y.(Z+1)`) up to `.10`, then rolls `X.Y.10` over to a new minor with
  patch `0`: `0.(Y+1).0` on 0.x, and `X.(Y+2).0` from 1.0 on, stepping over
  the odd minor that is the previous train's Marketplace pre-release number
  and that `publish-extension` refuses as a stable version. So the automatic
  PR after a `1.Y.10` release already proposes `1.(Y+2).0`; no hand edit is
  needed.

- **`version-bump.yml` is gated to the plain `vX.Y.Z` tag only**, so it doesn't
  double-fire off the `cli-` tag, and it skips pre-releases entirely. It opens
  a PR bumping every package manifest to the next dev version; that PR does
  **not** touch `CHANGELOG.md`.

- **Both publish jobs fail closed on a channel mismatch.** A `-preview.N`
  version whose GitHub release is not marked pre-release, or a bare version
  whose release is, stops at the first step. Delete the release, recreate it
  with the right flag, and the workflow re-runs.

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
