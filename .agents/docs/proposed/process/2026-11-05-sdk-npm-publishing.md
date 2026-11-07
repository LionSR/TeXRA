---
created: 2026-11-05
status: proposed
---

# Publishing the SDK pair from a tagged release

`@texra-ai/llm` and `@texra-ai/harness` have never been published. The
`releasing` skill has the owner publish them by hand, one at a time, with an
OTP. This note proposes publishing them the way `@texra-ai/cli` already is:
the owner cuts an `sdk-vX.Y.Z` GitHub release and CI publishes both packages
over npm Trusted Publishing, at one shared version. The implementation is on
branch `claude/sdk-publish-ci` (commit `b717f21`), not yet in a PR.

This contradicts one clause of the rulings ledger. D11
([ledger](../../implemented/architecture/2026-08-01-architecture-rulings-ledger.md),
"Typed-RPC deferral") records, as a parenthetical, that the two packages "are
npm-releasable, and publishing is the owner's manual step." The argument for
changing it is below; the owner keeps the decision to publish (the tag and the
release are still cut by hand), and only the upload moves to CI.

## Today

- Versions: both manifests are `0.1.0`; npm answers 404 for both names
  (checked 2026-11-05).
- Procedure (`.claude/skills/releasing/SKILL.md`, "npm packages" before this
  change): run `example:packed`, inspect the two tarballs, dry-run each,
  `pnpm publish` llm, then `pnpm publish` harness, typing the OTP each time,
  then install from the registry in an empty directory.
- Each package's `prepack` refuses npm: only pnpm applies
  `publishConfig.exports` (llm's workspace `exports` name `src/*.ts`) and
  rewrites `workspace:` and `catalog:` specifiers. The harness's peer on llm is
  `workspace:^`, so the packed harness names `@texra-ai/llm@^<llm version>`,
  and that llm version must be on npm first.
- The CLI publishes from `release.yml` on a `cli-vX.Y.Z` release, over OIDC
  (`id-token: write`), with no token and no OTP. Its job checks that the tag
  matches the manifest and that the GitHub pre-release flag matches the
  version form (`latest` versus `preview`).

The manual path has three failure points that nothing checks: publishing
harness before the llm version it names, a partial run (llm published,
harness not) whose retry must be done by hand, and a tarball inspected by eye.

## How pi does it

Read from `badlogic/pi-mono` at `55a5c69` (2026-11-05):
`scripts/release.mjs`, `scripts/publish.mjs`, `scripts/sync-versions.js`,
`.github/workflows/build-binaries.yml` (job `publish-npm`), and
`.pi/skills/release.md`.

- **Lockstep.** Every public package has one version. `sync-versions.js`
  fails when they differ and pins internal dependencies exactly.
- **One local command.** `npm run release:patch|minor` checks a clean tree
  and that every package already exists on npm, bumps, dates the changelogs,
  runs checks, tests and a packed-install check, commits, tags `vX.Y.Z` and
  pushes.
- **CI uploads.** The tag runs `publish-npm` in an `npm-publish` environment
  with `id-token: write`. `publish.mjs` packs every package first, skips any
  `name@version` already on npm, and runs
  `npm publish <tarball> --access public --provenance --ignore-scripts`,
  after a `--dry-run` pass. A failed job is re-run as is.
- **First publish is manual.** `release.mjs` refuses to run while any package
  is missing from npm, because a Trusted Publisher can only be attached to a
  package that exists.

## Two choices, compared

### Who uploads: the owner, or CI from a release the owner cuts

|                     | Manual (today)                          | CI from `sdk-vX.Y.Z`                              |
| ------------------- | --------------------------------------- | ------------------------------------------------- |
| Decision to publish | owner                                   | owner (cuts tag and release)                      |
| Credential          | owner's npm session + OTP               | OIDC token scoped to `release.yml`                |
| Order llm → harness | by hand                                 | the script                                        |
| Partial failure     | find which one landed, publish the rest | re-run the job; published versions are skipped    |
| Tarball check       | by eye                                  | script rejects a leftover `workspace:`/`catalog:` |
| Consumer check      | owner runs `example:packed`             | the job runs it before publishing                 |
| CI gate             | owner checks CI                         | `require-green-ci` on the tagged commit           |
| Provenance          | none                                    | npm attaches it under Trusted Publishing          |

The control D11 protects, that a person decides what ships, is kept: nothing
publishes without a release the owner creates. What changes is that the
mechanical steps after that decision run the same way every time. This is the
arrangement the CLI already has, so it adds no new kind of trust.

### Versions: independent, or one version for both

- **Independent** (today's skill): llm is republished only when it changes.
  The cost is a second number to track, a harness peer range whose floor must
  be checked against npm by hand, and a publish job that must decide which of
  the two to upload.
- **One version** (pi's choice, proposed): both manifests carry the same
  version, and the script refuses to publish when they differ. A release with
  no llm change still publishes an llm with that number. The harness's peer
  floor is then always the version being published in the same job, so the
  ordering problem disappears.

At 0.x with one consumer (TeXRA itself), the wasted llm version numbers cost
nothing; the bookkeeping saved is real. Revisit when llm gains consumers that
care about churn without changes.

## The design

On the branch:

- **`packages/harness/scripts/publish-npm.mjs`** (`--tag latest|preview`,
  `--dry-run`). Reads both manifests and fails unless the versions match. Packs
  both with `corepack pnpm --filter <pkg> pack` before uploading either, so a
  pack failure publishes nothing. Fails if a packed `package.json` still names
  `workspace:` or `catalog:`. For llm, then harness: skips the package if
  `npm view name@version` finds it, otherwise
  `npm publish <tarball> --access public --tag <tag>`. Uploading a tarball runs
  no package script, so the `prepack` guard against npm does not apply.
- **`.github/actions/npm-dist-tag`**, a composite action taking `manifest` and
  `tag-prefix`. It holds the check that was inline in `publish-cli`: the tag is
  `<prefix><version>`, the version is `X.Y.Z` or `X.Y.Z-preview.N`, and the
  GitHub pre-release flag agrees. `publish-cli` and `publish-sdk` both call
  it; the CLI's behavior is unchanged.
- **`publish-sdk` in `release.yml`**, on releases whose tag starts with
  `sdk-v`: require green CI, resolve the dist-tag from
  `packages/harness/package.json`, set up the workspace with the npm registry,
  install npm `^11.5.1`, run `example:packed`, dry-run the script, then run it.
  `version-bump.yml` only runs for plain `vX.Y.Z` tags, so `sdk-v` releases
  open no bump PR.
- **The skill** describes the tag flow and the one-time first publish.
  Root `AGENTS.md` says the pair publishes from an `sdk-v` release.

Not adopted from pi: the one-command local release (bump, changelog, commit,
tag, push). TeXRA's app release already has its own changelog and bump flow,
and the SDK pair has no changelog of its own yet. Setting two `version` fields
by hand is a smaller surface than a second release script.

## One-time setup (owner)

1. After the branch lands: `npm login`, then
   `node packages/harness/scripts/publish-npm.mjs --tag latest` from a clean
   checkout of `main` (publishes `0.1.0`, asks for the OTP).
2. On npmjs.com, for each of `@texra-ai/llm` and `@texra-ai/harness`: add a
   Trusted Publisher (GitHub Actions, this repository, workflow `release.yml`),
   as configured for `@texra-ai/cli`.
3. Update D11's parenthetical in the rulings ledger to say the pair publishes
   from an `sdk-v` release the owner cuts.

## Risks

- **The job has not run.** It runs only on a real `sdk-v` release. The first
  CI publish (`0.1.1` or `0.2.0`) is its first run; a failure before the
  publish step leaves npm untouched, and a failure between the two uploads is
  repaired by re-running.
- **A version is permanent.** `npm deprecate` is the only way back. The
  dry-run and `example:packed` steps run before any upload for this reason.
- **Lockstep is enforced only at publish time.** A PR that bumps one manifest
  passes CI and fails at release. A check in `gate:invariants` would catch it
  earlier; not added, because the release job reports it clearly and the bump
  is rare.

## Open questions for the owner

1. Accept the change to D11 (CI uploads; the owner still decides by cutting
   the release)?
2. Accept one version for both packages?
3. Should the SDK get its own changelog section (or file) for the `sdk-v`
   release notes, or are the release notes written by hand each time?

## Verified

- npm: `npm view @texra-ai/llm` and `npm view @texra-ai/harness` return 404
  (2026-11-05).
- pi-mono files read at `55a5c69`; the description above is from those files,
  not from memory.
- On the branch, locally: `publish-npm.mjs --tag latest --dry-run` packed both
  packages and dry-ran `+ @texra-ai/llm@0.1.0` then `+ @texra-ai/harness@0.1.0`;
  `--tag foo` printed the usage error; with llm at `0.1.1` it refused
  ("The SDK packages share one version"). `oxlint`, `format:check` and
  `check:guidance-refs` pass; both YAML files parse.
- Not verified: the `publish-sdk` job and the composite action in GitHub
  Actions, and Trusted Publishing for these two package names.
