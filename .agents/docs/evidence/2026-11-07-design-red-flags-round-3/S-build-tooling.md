# Area S: build and repo tooling

Read at `4e32bb921018ccb4626c0fb47b25a2c2d365b5f4` (main, 2026-11-07). Scope:
`scripts/`, `.github/workflows/` and `.github/actions/`, the root and package
`package.json` scripts and the package build scripts they name, `.oxlintrc.json`'s
overrides, the esbuild and Vite configs. The CLI's validators and the golden store
generator (`packages/cli/scripts/validate-*.mjs`, `generate-golden-store.mjs`,
`*-harness.ts*`) are test infrastructure and belong to area R.

Open PRs at that commit (REST listing): #14791 (package B), #14788 (package E,
lane 9), #14773, #14741. None of them touches a workflow, `.oxlintrc.json`, a
bundler config or a `package.json`. #14788 edits `scripts/verify-desktop.mjs:1593`
and `scripts/check-guidance-refs.mjs`. #14788 and #14791 both edit
`packages/desktop/design-harness/scenes/`. S5 cites both.

None of the scripts behind these findings is Effect code. The three tooling files
that import `effect` (`scripts/desktop-package-smoke-environment.mjs`,
`scripts/stub-internal-validation-model.mjs`, `packages/cli/scripts/*-harness.ts*`)
raise no finding here. So the mapping table at the end names the pnpm, oxlint,
GitHub Actions, Node or esbuild surface that answers each finding, as the task asks.

Recent tooling PRs, which this report does not re-propose: #14775 (typecheck runs at
once), #14748 (the ratchet baselines and the unexecuted-Effect scan deleted),
#14747 (desktop e2e only on desktop-host PRs), #14754 and #14750 (dead scripts
deleted), #14767 (SDK publish from `sdk-v`), and #14710 and #14690 as the task
names them.

## Numbers

| Path                             | Files | Lines  |
| -------------------------------- | ----- | ------ |
| `scripts/`                       | 34    | 6,075  |
| `packages/cli/scripts/` (area R) | 15    | 12,018 |
| `packages/harness/scripts/`      | 9     | 893    |
| `packages/desktop/scripts/`      | 2     | 197    |
| `packages/llm/scripts/`          | 1     | 74     |
| `packages/extension/scripts/`    | 1     | 31     |
| `.github/workflows/` (28 jobs)   | 11    | 2,146  |
| `.github/actions/` (composite)   | 3     | 114    |
| `.oxlintrc.json` (21 overrides)  | 1     | 580    |
| esbuild and Vite configs         | 6     | 339    |

- **npm scripts:** 78 in all (root 31, extension 14, cli 11, desktop 11, harness 5,
  llm 3, trace-viewer 3, texra 0).
- **Largest files in scope:**
  - `scripts/verify-desktop.mjs`: 1,845 lines
  - `.github/workflows/ci.yml`: 608
  - `.oxlintrc.json`: 580
  - `scripts/check-guidance-refs.mjs`: 579
  - `scripts/smoke-webviews-electron-runner.cjs`: 575
- **Comment share, worst files of 200 lines or more:**
  - `ci.yml`: 27% (167/608)
  - `release.yml`: 21% (57/268)
  - `check-guidance-refs.mjs`: 19% (113/579)
  - `claude-code-review.yml`: 16% (34/208)
  - `vscode-host-e2e-runner.mjs`: 16% (34/211)

  Most of `ci.yml`'s comments explain which job may be skipped when (see S1 and S8).

- **Counts:**
  - Workflow steps that run `node <script>` directly: 25. By workflow: ci 5,
    desktop-package 14, release 4, docs-deploy 1, version-bump 1.
  - Restriction entries in `.oxlintrc.json`: 58, of which 28 are distinct.
  - Bash copies of the release version grammar: 3, plus one semver parser.
  - Jobs that use `setup-workspace`: 17.
  - Step blocks duplicated across workflows: 3, together about 95 lines.
  - Scripts with no automated invoker: the `smoke-webviews` stage with its 2 files,
    and the design harness (7 files).
  - Script exports with no importer: 2.

## Findings

### S1. The release gate trusts a `validate` run that skipped the checks, so each release job runs them again, and two package builds carry a type check

Red flags: an error the design could rule out, a CI step that restates a
script, and a conjoined script (`build` = type check + bundle).

**Evidence.**

- **What the gate reads.** `.github/actions/require-green-ci/action.yml:16-18` takes
  the newest check run named `validate` on the commit, whatever event started it.
- **What a nightly run checks.** The nightly `schedule` run (`ci.yml:8-9`) validates
  main's tip, but skips invariants, typecheck, build, vscode-host-e2e and
  desktop-e2e (`ci.yml:119,182,304,359,395`). `validate-status` allows those skips on
  a schedule (`ci.yml:580-597`). A nightly `validate` is therefore green without any
  static check, build or e2e run.
- **The hole.** Once the nightly has run, it is the newest `validate` on that SHA.
  Suppose a push run fails `build` or `invariants`, and the nightly that follows is
  green (Windows shards, runtime validation, packed example). Then
  `require-green-ci` passes, and the extension, CLI, SDK and desktop publishes all go
  ahead (`release.yml:52,198,237`, `desktop-package.yml:51`).
- **The extension job makes up part of the gap by running the checks again:**
  - `release.yml:124-125` runs `pnpm run typecheck`, the last step of
    `gate:typecheck` (`package.json:21`).
  - `release.yml:127-135` runs `sync-package-contributes.mjs --check`, which is
    already in `gate:invariants` (`package.json:20`). Its comment gives the reason:
    "a release cut from a commit whose catalog drift bypassed PR CI".
- **Desktop.**
  - `packages/desktop/package.json:22`: `build` is `typecheck` (five `tsc`
    programs, `:18`) followed by the three bundles.
  - The root `desktop:build` (`package.json:16`) runs it in all three installer jobs
    (`desktop-package.yml:74,154,206`), after `require-green-ci`.
  - CI's desktop-e2e writes the three bundle steps out by hand to avoid that type
    check (`ci.yml:406-412`: "The three bundles only: typecheck is the Linux
    static-checks job's"). It also skips the trace-viewer build that `desktop:build`
    does, so the build e2e tests is not the build that ships.
- **CLI.** `packages/cli/package.json:49`: `build` is `typecheck && smoke:react-compiler && …`,
  and `publish-cli` relies on `prepack` → `build` (`release.yml:216-222`) as its type
  check. `gate:typecheck` already runs the React Compiler smoke (`package.json:21`).
- **The rule these break.** `AGENTS.md:39`: "Builds don't type check."

**The design decision behind it.** "Is this commit fit to release?" CI's `validate`
answers it. Each publishing job then answers it again, partly, because the gate can
read the wrong run.

**The better design.**

- **One gate.** `require-green-ci` reads a CI run of a full-validation event. For
  example: `gh run list --workflow ci.yml --commit "$GITHUB_SHA" --json event,conclusion,startedAt --jq '[.[] | select(.event == "push" or .event == "workflow_dispatch")] | sort_by(.startedAt) | last | .conclusion // "none"'`.
  The REST form is `actions/workflows/ci.yml/runs?head_sha=…&event=push`. A commit
  with no such run fails closed, as it does today.
- **Deleted:**
  - the two release steps (`release.yml:124-135`, 12 lines with their comment);
  - `corepack pnpm run typecheck &&` in the desktop `build`;
  - `npm run typecheck && npm run smoke:react-compiler &&` in the CLI `build`.
- **CI's desktop-e2e** calls `pnpm run desktop:build`: four lines become one, and e2e
  tests the shipped build.

**What we give up.** A local `pnpm pack` of the CLI no longer type checks first. If
that is wanted, it belongs in `prepack: npm run typecheck && npm run build`, not in
`build`. A desktop installer dispatched on a commit with no push run now fails closed
instead of type checking.

**Change amplification.** Adding a release-time check today means deciding, in CI and
again in each of 3 publishing workflows, whether to repeat it. Afterwards it goes in
CI only. A red push run followed by a green nightly: passes today, fails after.

**Depends on:** none.

### S2. `npm run gate` is documented as the static CI jobs, but three CI checks are not in it

Red flags: two representations of one fact, a CI step with no script behind
it, and a comment standing in for design.

**Evidence.**

- **The claim.** `AGENTS.md:28` says `npm run gate` is "the static CI jobs";
  `ci.yml:112-115` says "a local `npm run gate` reproduces exactly what these jobs
  enforce". `gate` is `package.json:19-21`.
- **The checks it misses.** The `guidance-refs` job (`ci.yml:200-239`) runs
  `check-guidance-refs.mjs` (`:223`), `check-proposal-status.mjs` (`:229`) and
  `docs/scripts/check-root-docs.mjs` (`:239`). None of the three is in
  `gate:invariants` (`package.json:20`).
- **Scripts CI does not use.** The `check:guidance-refs` npm script
  (`package.json:36`) has no CI caller: `ci.yml` runs `node` directly.
  `check-proposal-status.mjs` has no npm script at all; CI is its only invoker.
- **Three homes for one list.** The list "static checks a change must pass" lives in
  `gate:invariants` (7 commands), the `guidance-refs` job (3) and
  `.pre-commit-config.yaml` (2 of the 3, at `:16-21` and `:35-40`, plus oxfmt). They
  disagree.
- **Effect.** A local `npm run gate` passes on a stale guidance path or a `proposed/`
  note that declares itself done, and CI fails it.
- **A vague name.** `gate:typecheck` runs the React Compiler smoke, `format:check` and
  `typecheck`.

**The design decision behind it.** "Which checks gate a change" has no single owner.
The ungated docs job was added to CI and never to the script.

**The better design.**

- Add one `gate:docs` script holding the three `node` commands. It installs nothing,
  because `npm run` of a `node` script needs no `node_modules`.
- `gate` becomes `gate:invariants && gate:docs && gate:typecheck`.
- The ungated `guidance-refs` job runs `npm run gate:docs`: three steps become one.
- `check:guidance-refs` folds into `gate:docs`. `AGENTS.md` "Docs" cites `gate:docs`.
- Pre-commit keeps its two scoped hooks, which are per commit.

**What we give up.** Nothing. `gate` takes about 0.3 s longer.

**Change amplification.** A new docs-side check today touches `ci.yml`, maybe
`package.json`, maybe `.pre-commit-config.yaml`, and `gate` quietly misses it.
Afterwards: one line in `package.json`.

**Depends on:** none.

### S3. The oxlint config restates 30 of its 58 restriction entries and copies the tsconfig alias map twice

Red flags: repetition, information leakage, and a comment standing in for
design (the rule in `AGENTS.md:131-132`).

**Evidence.** `.oxlintrc.json` has 21 overrides. Of the 58 restriction entries in
them, 28 are distinct. Repeated entries:

| Entry                                          | Copies    | Where                                 |
| ---------------------------------------------- | --------- | ------------------------------------- |
| `vscode` import ban                            | 9         | `:75,104,147,193,209,231,260,277,318` |
| host-layer group (8 aliases)                   | 3         | `:79-89`, `:108-118`, `:151-161`      |
| browser-bundle `@common`/`@tools` group        | 2         | `:121-124`, `:234-237`                |
| browser-bundle `@utils` group                  | 2         | `:126-129`, `:239-242`                |
| `^@texra-ai/harness(/host\|/node\|/plugins)?$` | 3         | `:131`, `:212`, `:244`                |
| llm "imports nothing else in the repo" regex   | 2         | `:280`, `:321`                        |
| `Effect.run*` list (7 entries)                 | 2         | `:343-373`, `:394-423`                |
| `.then` ban                                    | 2         | `:424-427`, `:447-450`                |
| CLI `process`/`console` bans                   | 3 subsets | `:466-512`, `:519-541`, `:553-570`    |

- **The llm regex is the alias map.** It spells out all 25 `@x/*` aliases of
  `tsconfig.json:24-147`; I compared the two sets and they are identical.
  `scripts/aliasUtils.mjs:11-27` already reads that map for Vite and Vitest.
- **Why it is restated.** The cause is oxlint's override semantics: a later override
  replaces a rule's options. `AGENTS.md:131-132` makes the restatement a rule
  ("each import block restates every pattern that holds for its files").
  `AGENTS.md:183` asks for the VS Code-free list to be kept "in sync" by hand.
- **The copies already differ.** Four browser bundles get different subsets of the
  three browser-bundle patterns:

  | Bundle                                                     | Patterns |
  | ---------------------------------------------------------- | -------- |
  | `packages/texra/src/ui/`                                   | 3        |
  | the settings frontend                                      | 3        |
  | `packages/desktop/src/renderer/`                           | 1        |
  | `packages/trace-viewer/src/` (only in the run ban, `:339`) | 0        |

  The trace viewer imports `@texra-ai/harness/schemas` six times, and nothing stops
  it importing `/node`. No note records that choice. Today the subset is whatever was
  copied.

**The design decision behind it.** "Which bans hold for a directory" is a union over
zones (VS Code-free, browser bundle, harness, llm, core, CLI). The JSON format makes
every override carry the whole union for its files.

**The better design.**

- **A TypeScript config.** Use `oxlint.config.ts` with `defineConfig` (oxlint 1.91:
  `node_modules/oxlint/dist/index.d.ts:7103`, and `extends` of config objects at
  `:7095`). Loading it needs Node ≥22.18; the repository floor is 22.22.2.
- **Named sets.** Each pattern set is a named constant: `VSCODE`, `HOST_LAYER`,
  `APP_ALIASES`, `BROWSER_BUNDLE`, `RUN_EFFECT`, `CORE_THEN`, `CLI_PROCESS`,
  `CLI_CONSOLE`.
- **Overrides are spreads.** Each override's `patterns` spreads the sets of its zone,
  and each zone list (browser bundles, core) is one array.
- **Alias groups are derived** from `tsconfig.json` `paths` by target directory with
  `loadAliases`:
  - the host layer is the aliases into `packages/{extension,cli,desktop}` and
    `src/test-kernel`;
  - the app is the aliases into `packages/texra`;
  - llm's ban is every alias.
- **Deleted.** About 30 restated entries (roughly 260 JSON lines) and the restating
  rule in `AGENTS.md:131-132`. `AGENTS.md:183` points at the zone table instead.
- **Fallback.** If the experimental loader is unacceptable, generate the JSON from the
  same module and check it in `gate:invariants`, as
  `sync-package-contributes.mjs --check` does for the manifest.

**What we give up.** `oxlint --help` calls JavaScript and TypeScript configs
"experimental". An editor integration that reads only JSON may not follow. The
generated-JSON fallback avoids both, at the cost of one more `--check` script. No
rule is added, so `AGENTS.md:142-143` ("not another lint rule") holds.

**Change amplification.** Adding a host alias (`@web/*`): today `tsconfig.json`, 5
places in `.oxlintrc.json` (2 llm regexes and 3 host-layer groups) and `AGENTS.md`
prose. Afterwards: `tsconfig.json` only. Adding a browser bundle: today a 3-to-5
pattern copy; afterwards one line in the zone list.

**Depends on:** none.

### S4. The release version grammar and the tag, manifest and pre-release check are written in four places

Red flag: information leakage (one grammar, many readers).

**Evidence.**

- **Three bash copies** of `X.Y.Z` / `X.Y.Z-preview.N` together with "the tag names
  the manifest version" and "the pre-release flag agrees with the form":
  - `.github/actions/npm-dist-tag/action.yml:32-57`, used by the CLI and SDK jobs
    (`release.yml:201-206`, `:242-247`);
  - `release.yml:60-89`, the extension job, which needs the parsed parts too;
  - `desktop-package.yml:313-330`, with its own pre-release consistency check at
    `:357-361`.
- **A fourth reading.** `version-bump.yml:24` tests the form as
  `!contains(tag, '-')`.
- **The parser.** `scripts/bump-workspace-version.mjs:24-31,84-115` is the semver
  parser of the same grammar. Its comment (`:28-29`) says the identifier is fixed "so
  that every workflow can tell a preview from a stable version with one regex": every
  workflow is expected to restate it.
- **A second rule in two homes.** The Marketplace even/odd-minor rule is in
  `release.yml:91-108` and in `bump-workspace-version.mjs:33-36,134-141`, and each
  cites the other.
- `packages/harness/scripts/publish-npm.mjs:24` accepts `latest|preview` again.

**The design decision behind it.** "What a release version is, and which channel it
publishes to" is decided by the bump script, then decided again by each publishing
job.

**The better design.**

- **One module.** Move `parseVersion` and `formatVersion` out of
  `bump-workspace-version.mjs` into `scripts/release-version.mjs`, and have the bump
  script import them.
- **One command.** The module's CLI takes
  `--tag --prefix <v|cli-v|sdk-v> --manifest --prerelease`. It fails on any mismatch
  and writes `channel`, `npm_tag` and `marketplace_version` to `$GITHUB_OUTPUT`.
- **One action.** The existing composite action, renamed `npm-dist-tag` →
  `release-channel`, runs that command. The extension job, both npm jobs and the
  desktop publish call it. The extension job keeps only its manifest renumbering,
  which the script can also do.
- **Deleted.** About 55 lines of bash in three files. `release.yml:60-119` shrinks to
  one step.

**What we give up.** The logic is no longer readable inline in the workflow. The steps
need Node, which they already have (`release.yml:61` runs `node -p`).

**Change amplification.** Admitting `-rc.N`, or changing the even/odd rule: today 5
files (`bump-workspace-version.mjs`, the action, `release.yml`,
`desktop-package.yml`, `version-bump.yml`) plus `publish-npm.mjs`. Afterwards: 1
module plus `version-bump.yml`'s `if:`.

**Depends on:** none.

### S5. Scripts nothing runs, which carry untyped copies of the session protocol and are still edited on every row change

Red flags: scripts nothing runs, information leakage, and a false comment.

**Evidence.**

**(a) The `smoke-webviews` stage.**

- **What it is.** `scripts/verify-desktop.mjs:1513-1810` (298 lines with fixtures),
  `scripts/webview-electron-harness.mjs` (161) and
  `scripts/smoke-webviews-electron-runner.cjs` (575): 1,034 lines in all.
- **Who runs it.** One invoker, `npm run smoke:webviews` (`package.json:23`), cited
  only in `docs/dev/vscode-activation-smoke.md:9`. No workflow runs it.
- **A second copy of the session wire.** The events frame
  (`webview-electron-harness.mjs:103-130`: `kind: 'events'`, `generation`, `cursor`,
  `local`, `replayComplete`, `existence`) is written "the way `SessionFramer` cuts a
  frame" (`verify-desktop.mjs:1520-1525`). A host snapshot (`:1532`) and session
  rows (`:1566-1680`, `run.start` with its approval policy, `run.position`) are
  written by hand in untyped JavaScript.
- **Kept in step by grep.** Open PR #14788 edits `verify-desktop.mjs:1593`
  (`userFollowUpSupport` → `takesFollowUps`) to keep that copy current. Nothing type
  checks it, and nothing runs it.
- **Assertions that never run.** Its two layout assertions
  (`smoke-webviews-electron-runner.cjs:483-500`) run nowhere.
- **What CI already covers.** Webview rendering is covered by vscode-host-e2e, which
  opens the panels in real VS Code (`ci.yml:349-374`,
  `vscode-host-e2e-suite.cjs:100`), and by the desktop Playwright suite over real
  sessions (`ci.yml:385-424`), whose `appearance` project screenshots them.
- **The doc is false.**
  - `docs/dev/vscode-activation-smoke.md:12` says the smoke "renders the launcher",
    but the stage has no launcher view (`verify-desktop.mjs:1708-1757`).
  - `:30-31` says `test:vscode` runs "not on pull requests", but `ci.yml:356-359` runs
    it on VS Code-host PRs and never nightly.

**(b) `packages/desktop/design-harness/` (7 files, 1,389 lines).**

- **No runner.** No package script or workflow starts it. A grep for `design-harness`
  finds only `packages/desktop/tsconfig.tooling.json:8` and one proposal.
- **Paid for anyway.** Every `npm run typecheck` checks it
  (`packages/desktop/package.json:18`).
- **Edited on every UI change.** Its fixtures were changed by 5 of the 66 commits in
  this clone and by both open package PRs (#14791 `scenes/settings.ts`, #14788
  `scenes/extension.ts`).
- **A false comment.** `harness.ts:3` says "Untracked"; the files are tracked.
- **A drifting list.** `shoot.mjs:9-35` lists 23 of the 36 scenes by hand.

**(c) Exports nothing imports.**

- `renamesSince` (`scripts/ratchet-base.mjs:65-82`): its last consumer went with
  #14748.
- `loadAliasEntries` (`scripts/aliasUtils.mjs:29-50`): 0 importers.

**The design decision behind it.** A tool with no runner has no owner. It costs a
change every time a row or frame changes, and it checks nothing.

**The better design.**

- **Delete the smoke-webviews stage**, its two files, `smoke:webviews` and the doc
  section. If the owner wants the two layout assertions, they move into the desktop
  `appearance` project, against the typed fixtures.
- **The design harness is the owner's call.**
  - Either a `design:shoot` script in `packages/desktop`, with the scene list read from
    the scene tables (`Object.keys(extensionScenes)` and the others) instead of
    `shoot.mjs`'s literal;
  - or deletion.
- **Delete the two dead exports.**
- **Correct the doc.**
- **Deleted in all:** about 1,040 lines (the stage, two files, a script, a doc
  section and 40 lines of dead exports), more if the design harness goes.

**What we give up.** A way to screenshot the extension webviews from the built bundles
without VS Code. The design canvas screenshots, if the harness is deleted.

**Change amplification.** Renaming one run-row field: #14788 touches 1 untyped script,
4 design-harness sites and 1 e2e spec. Afterwards: the e2e spec, plus the typed design
harness if it is kept.

**Depends on:** none. Coordinate with #14788, which edits `verify-desktop.mjs:1593`.

### S6. Every host's bundler config restates what bundling the harness needs, and sets its target by hand

Red flags: information leakage, change amplification, and a false comment.

**Evidence.**

- **The worker plugin, 5 times.** The `codeSandboxWorker` plugin is imported in 4
  esbuild configs:
  - `packages/extension/esbuild.config.mjs:5,48`;
  - `packages/desktop/esbuild.main.mjs:11,68`;
  - `packages/cli/scripts/build-bundle.mjs:57,97`;
  - `packages/harness/scripts/bundle.mjs:4,37`.

  It is restated a fifth time as a Vite plugin (`vitest.config.mjs:240-255`).

- **The wasm loader, 5 times.** The `'.wasm': 'binary'` loader is in 4 configs
  (extension `:29`, desktop `:63`, CLI `:73`, harness `:39-41`), plus Vitest's
  `quickJsWasmPlugin` (`vitest.config.mjs:215`).
- **The build identity, 3 times.** `buildIdentityDefine` is used by extension `:44`,
  desktop `:67` and CLI `:74`.
- **`keepNames` three ways.**
  - Extension `:22-23`: set only in production. Its reason names `sdkErrorUtils`, a
    module that no longer exists (0 grep hits).
  - CLI `:88`: always set, with the correct reason at `:85-87`.
  - Desktop: unset (the desktop bundle is not minified).

  The fact behind all three is one: "a minified bundle must keep class names, because
  `sdkError/` reads `constructor.name`". A fourth host that minifies without it
  misclassifies provider errors silently.

- **Targets by hand.** Extension `'node18'` (`:18`), CLI `'node20'` (`:71`), desktop
  `'node22'` (`:65`). The CLI's own engines floor is `^22.22.2`
  (`packages/cli/package.json:37`).
- **Vite.** The same 4-package `dedupe` list is in three configs:
  `packages/desktop/vite.config.ts:40-45`, `packages/trace-viewer/vite.config.ts:43-48`
  (whose comment at `:5` says it is the same recipe as desktop's) and
  `packages/desktop/design-harness/vite.config.ts:14-19`.

**The design decision behind it.** "What a bundle needs in order to inline the harness's
sources" is the harness's fact. Every host restates it because every host bundles the
harness's sources through tsconfig paths.

**The better design.**

- **One base.** `scripts/hostBundle.mjs` exports the shared esbuild base:
  `{ bundle: true, loader: { '.wasm': 'binary' }, plugins: [codeSandboxWorker], define: buildIdentityDefine(), keepNames: true }`.
  The three host configs spread it, and the `.tex` loader stays with the two hosts
  that import `chatExport.tex`.
- **Targets follow facts.** The CLI's target comes from its `engines` with
  `semver.minVersion`. The extension's stays a constant whose comment names the VS Code
  Electron it follows.
- **Vite.** `scripts/aliases.mjs`, already the shared Vite module, exports `dedupe`
  beside `aliases`.
- **Deleted:** 6 imports, about 9 option lines, the stale comment, and 2 `dedupe`
  copies.
- **Stronger alternative.** Hosts could consume the harness's built entries, whose
  `dist` already inlines the worker and the wasm. That gives up source-level watch
  builds and adds a build order; it is not recommended now.

**What we give up.** A host can no longer diverge silently. A host that really needs a
different option overrides it in its spread, visibly.

**Change amplification.** A second worker or virtual module in the harness: today 5
build configs. Afterwards: 2 (the shared base and the Vitest plugin).

**Depends on:** none. Borders S7.

### S7. The harness's six entries are listed in five places, and the two SDK packages export in opposite conventions

Red flags: information leakage, and special and general code mixed. This
borders area Q (the entry files).

**Evidence.**

- **Six entries, five lists.** The entries `.`, `schemas`, `transcript`, `plugins`,
  `host` and `node` are listed in:
  - `packages/harness/package.json:36-61` (`exports`, pointing at `dist`);
  - `packages/harness/scripts/bundle.mjs:12-19` (`entryPoints`);
  - `tsconfig.build.json:10-16` (`include`);
  - `tsconfig.json:16-23` (six `paths` entries);
  - `.oxlintrc.json:386-391` (the core file list).
- **A sixth reading.** The `(/host|/node|/plugins)` regex (S3, 3 copies) encodes which
  entries are not browser-safe.
- **The opposite convention.** The llm package's `exports` name its sources
  (`packages/llm/package.json:35-39`) and its `publishConfig.exports` name `dist`
  (`:40-48`), so llm needs no tsconfig `paths` entry.
- **Both tools carry both conventions.**
  - `scripts/check-api-report.mjs:44-49` strips either `src/` or `dist/types/`.
  - `packages/harness/scripts/validate-artifacts.mjs:18,33` reads
    `publishConfig?.exports ?? exports`.
- **Nothing uses the harness's convention.** Nothing in the workspace reads
  `packages/harness/dist`: a grep for `harness/dist` finds only
  `tsconfig.build.json:6` and `AGENTS.md:43`. No note gives a reason for the
  difference (grep for `publishConfig`).

**The design decision behind it.** "What a workspace consumer resolves for an SDK
subpath" is decided twice, in two different ways, for sibling packages built and
checked by the same scripts.

**The better design.**

- **One convention, llm's.** The harness's `exports` name `src/*.ts` and its
  `publishConfig.exports` name `dist`. pnpm applies `publishConfig.exports` at pack
  time, and the harness's `prepack` already refuses npm (`:68`).
- **Derived entries.** `bundle.mjs` reads its `entryPoints` from
  `publishConfig.exports`, mapping each `import` path's name to its `types` source the
  way `check-api-report` already does.
- **Deleted.** The six `@texra-ai/harness*` lines in `tsconfig.json:16-23`, and the
  second branch in `check-api-report` and in `validate-artifacts`.
- **Declared instead.** The two workspace members that import the harness without
  declaring it, the root (`src/test-kernel`) and `packages/trace-viewer`, add
  `"@texra-ai/harness": "workspace:*"`.

**What we give up.** Harness subpaths resolve through the workspace link and `exports`
instead of tsconfig `paths`. That is the route llm already takes. The risk is a tool
that ignores `exports`; none in this repository does for llm.

**Change amplification.** Adding a seventh subpath: today 5 files. Afterwards:
`package.json`, plus a zone line in S3 if the subpath is not browser-safe.

**Depends on:** none. S3's derived core list would read the same `exports`; agree the
entry files with area Q.

### S8. CI job lists and path sets kept by hand, three times over

Red flags: repetition, a false comment, and a comment standing in for design
(27% of `ci.yml` is comment).

**Evidence.**

- **`validate-status` lists the jobs three times.** In `needs` (`ci.yml:525-536`), in
  the result loop (`:563-572`) and in the code-required loop (`:585-589`). Around them
  sit 47 lines of bash and comments (`:540-608`) explaining which skip is legitimate
  when.
- **Three installer jobs for one sequence.** `desktop-package.yml` writes the same
  sequence three times: macOS `:54-134`, Linux `:136-178`, Windows `:180-246`. The
  differences are unexplained:
  - only Windows runs `electron-binary` and `build-artifacts` (`:202-209`);
  - Linux calls `package:dist` (`:157`), while the other two call electron-builder
    directly (`:104`, `:218`).

  The publish job then restates the three results (`:264-277`).

- **Change detection.**
  - The session-layer path set is spelled twice (`ci.yml:88`, `:96`).
  - The published-package filter's comment ("what their bundles inline (two scripts/
    files…)", `:101-106`) lists `stub-internal-validation-model.mjs`. Only the CLI
    bundle imports that file (`packages/cli/scripts/build-bundle.mjs:62`; 0 hits in
    `packages/{harness,llm}`). A CLI-only change therefore triggers the packed-example
    job.

**The design decision behind it.** Each list names something GitHub Actions already
holds: the `needs` context, a matrix, a shell variable.

**The better design.**

- **`validate-status`** checks `${{ toJSON(needs) }}` with `jq` (every result
  `success` or `skipped`) and names only the jobs a code change requires. One list
  remains: `needs`.
- **The installers** become one job with `strategy.matrix.include` rows (runner,
  signing platform, app path, artifact globs). The Windows-only checks either run in
  every row or get a comment. The publish job checks `toJSON(needs)` too.
- **Change detection.** A `session_layer=` shell variable is used by both greps, and
  the packages filter names `code-sandbox-worker.mjs` alone.
- **Deleted:** 2 of the 3 job lists, about 120 lines of installer jobs, and 1 false
  comment.

**What we give up.** Per-job display names stay, but matrix rows read less linearly
than three separate jobs.

**Change amplification.** Adding a CI job: 3 edits today, 1 afterwards. Adding an
installer platform: a 60-line job plus the publish check today, one matrix row
afterwards.

**Depends on:** none.

### S9. The agent workflows duplicate step blocks verbatim, and the review tool allowlist has two forms

Red flag: repetition.

**Evidence.**

- **"Report denied tool calls".** 43 identical lines (I compared them with `diff`) in
  `claude.yml:94-136` and `claude-code-review.yml:139-181`.
- **"Remove re-review label".** Identical in `claude-code-review.yml:46-60` and
  `texra-code-review.yml:35-49`.
- **The provider-token check.** The provider-to-secret `case` is in
  `claude-code-review.yml:62-93` and in `issue-tracker.yml:50-73`. `claude.yml` and
  `issue-tree.yml` check nothing.
- **The provider env block.** `CLAUDE_CODE_PROVIDER` plus two secrets is repeated in
  4 workflows: `claude.yml:38-40`, `claude-code-review.yml:36-38`,
  `issue-tracker.yml:41-43`, `issue-tree.yml:20-22`.
- **Two forms of the tool allowlist.**
  - Presets in `.github/automation/allowed-tools.json`, used by 3 workflows.
  - An inline `CLAUDE_ALLOWED_TOOLS` env in `claude-code-review.yml:39-40`. Whether
    the external `LionSR/agent-ci-actions@v1` reads that env cannot be checked from
    this tree.

**The design decision behind it.** The repository already has composite actions for
shared steps (`setup-workspace` with 17 uses, `require-green-ci`, `npm-dist-tag`). These
three blocks were copied instead.

**The better design.**

- Three composite actions: `report-denied-tools`, `consume-label` (input: the label)
  and `provider-token` (outputs `skip` and `reason`).
- A `claude-code-review` preset in `allowed-tools.json` replaces the inline list.
- **Deleted:** about 95 lines.

**What we give up.** Each workflow file is no longer readable alone. In the review
workflows the actions must be loaded from `.trusted-actions` (the base checkout), as
the prompts already are, never from the PR head.

**Change amplification.** Changing the denial report's `awk`: 2 files today, 1
afterwards.

**Depends on:** none.

### Thin items, batched

- **Two file walkers named `walkFiles`.**
  - `scripts/walkFiles.mjs` is synchronous, with `include`, `prune` and `limit`
    options; it has 7 callers.
  - `packages/harness/scripts/fsWalk.mjs:62-72` is asynchronous, over
    `readdir(…, { recursive: true })`; it has 3 callers.

  Node 22's `readdirSync({ recursive, withFileTypes })` (`@types/node` `fs.d.ts:2160`)
  covers the harness's form. Of the root walker's options, `prune` has one caller
  (`check-fact-spread.mjs:58`) and `limit` one
  (`verify-extension-package-invariants.mjs:88`). Keep one walker.

- **Extension-only scripts at the root.** `scripts/clean-extension-dist.mjs` (15
  lines) and `scripts/copy-extension-docs.mjs` (19) are invoked as `node ../../scripts/…`
  from `packages/extension/package.json:547-548`. The extension's other script lives in
  `packages/extension/scripts/`, and `packages/harness/scripts/clean.mjs` is the same
  `rm`. Move them, or inline them.
- **A vague name.** `scripts/extension-package-utils.mjs` holds a desktop fact
  (`requiredMonacoWorkers`, `:9-15`, whose only consumer is `verify-desktop.mjs`) and
  a generic `readJson` (used by `bump-workspace-version.mjs`).
- **A hand-kept package list.** `scripts/check-fact-spread.mjs:39-47` lists the seven
  `packages/*/src` directories; `fs.globSync('packages/*/src')` would follow the
  workspace.
- **The crash-conformance exclude, twice.** `package.json:12,15` restate it in
  `test:changed` and `test:watch`. This is area R's tier configuration; reported only
  for the count.

## Good modules in this area

- **`scripts/check-api-report.mjs`.** It reads the entries from each package's
  `exports` (`coreEntries`, `:33-58`). One type-checked program produces both the
  report and the reference, with one check mode and one write mode. Adding an entry
  needs no edit here.
- **`scripts/ratchet-base.mjs`** (`ratchetBase`, `withBaseTree`). Checks measured
  against the merge base, with no committed baselines and a loud error when the base
  is missing. `check-fact-spread.mjs` and `check-row-kinds-ever.mjs` stay small because
  of it (apart from the dead `renamesSince`).
- **`scripts/sync-package-contributes.mjs`.** The manifest's `contributes` subtrees are
  generated from the catalogs and checked with `--check`. One owner, and the generated
  copy cannot drift.
- **`scripts/aliasUtils.mjs`'s `loadAliases`.** `tsconfig.json` is the only alias map
  for Vite and Vitest. S3 and S6 extend that same reading.
- **`.github/actions/setup-workspace`.** One install recipe for 17 jobs.
- **`scripts/verify-desktop.mjs`'s stage table and single reporter** (`:1813-1845`).
  A deep entry for six artifact checks, each returning its failures to the reporter,
  with heavy dependencies loaded per stage (the smoke-webviews stage aside, S5).
- **`packages/harness/scripts/validate-artifacts.mjs`.** One validator for both SDK
  builds (`packages/llm/scripts/build.mjs:74` calls it).
- **`check-row-kinds-ever.mjs` and `rowVersions.vitest.ts`.** These are complementary,
  not duplicates. The script compares against git history (append-only versus the
  merge base); the suite checks the current tree (sorted, complete, retired kinds
  listed).

## Already settled, left alone

- **The desktop's five `tsc` programs** (`packages/desktop/package.json:18`). #14775
  just reworked the type checks, and each Electron process has its own `lib` and
  `types`. Not re-proposed. S1 moves the type check out of `build` only.
- **No new lint rule.** #14748 deleted the core-quality ratchet and the
  unexecuted-Effect scan; ESLint gave way to oxlint and the architecture tests were
  deleted. S3 adds no rule, consistent with `AGENTS.md:142-143`.
- **In-workflow change detection instead of `on.paths`.** A required `validate` check
  cannot be path-filtered (`ci.yml:356-358`), so the `changes` job stays; S8 only
  dedupes its patterns. Desktop e2e only on desktop-host PRs (#14747) and Windows
  shards nightly only (`ci.yml:257-274`, #12943) stay as ruled.
- **`check-root-docs.mjs` in four homes.** The ungated `guidance-refs` job, the docs
  `check:content` script, pre-commit and docs-deploy each run it, and each place has a
  comment saying why (`ci.yml:202-206,231-237`, `.pre-commit-config.yaml:11-15`,
  `docs-deploy.yml:176-181`). S2 changes only what `gate` includes.
- **`live-llm.yml:117-128`'s key list.** It matches the 12 suites in
  `packages/llm/test-live/` one for one. GitHub Actions has no narrower way to hand a
  job a set of secrets.
- **`runtime-validation` pinned to Node 22.22.2** (`ci.yml:475`). That is the engines
  floor, so the pin is on purpose.
- **`check-guidance-refs.mjs`'s `NOT_ROWS`.** Already found
  (`2026-11-06-root-designs-pr1-compromises.md`), and open PR #14788 rewrites it.
- **`publish-sdk` re-runs `example:packed`** (`release.yml:257-258`). That is on
  purpose: a consumer's install can change with no commit here (`ci.yml:441-442`).
- **The Deno edge-function validation** (`ci.yml:158-177`). It is CI-only because it
  needs Deno, and says so.

## Mapping

None of the scripts behind these findings is Effect code, so each finding maps to
the tool or config that answers it, with the declaration or surface checked.

| Finding                                            | What answers it                                                                                                                          | Declaration or surface checked                                                                                                                                                |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1 the release gate reads the nightly's `validate` | GitHub Actions: the workflow-runs listing filtered by `head_sha` and `event` (`gh run list --workflow --commit --json event,conclusion`) | REST `GET /repos/{o}/{r}/actions/workflows/{id}/runs?head_sha=&event=`; the composite already calls `gh api` (`require-green-ci/action.yml:76`)                               |
| S2 `gate` misses the docs checks                   | pnpm/npm scripts: one `gate:docs` that `gate` and the ungated job both run                                                               | `package.json:19-21`; `npm run` of a `node` script needs no install (the job installs nothing, `ci.yml:205-206`)                                                              |
| S3 oxlint restates patterns                        | oxlint TypeScript config with named sets and `extends`; alias groups from `loadAliases`; fallback: generated JSON plus `--check`         | `node_modules/oxlint/dist/index.d.ts:7103` (`defineConfig`), `:7095` (`extends?: OxlintConfig[]`); `oxlint --help`: JS/TS configs "experimental"; `scripts/aliasUtils.mjs:11` |
| S4 version grammar ×4                              | Node script over `semver.parse` behind one composite action                                                                              | `node_modules/semver/functions/parse.js`; `bump-workspace-version.mjs:84-115`; `.github/actions/npm-dist-tag/action.yml`                                                      |
| S5 scripts nothing runs                            | Delete; the layout checks, if kept, go to the Playwright `appearance` project                                                            | `packages/desktop/playwright.config.ts:29` (`appearance`); `ci.yml:349-424` (the e2e jobs that already render the webviews)                                                   |
| S6 host bundlers restate harness needs             | One esbuild base object spread by each config; target from `engines` via `semver.minVersion`                                             | `node_modules/esbuild/lib/main.d.ts:116` (`BuildOptions`), `:78` (`keepNames`), `:25` (`target`)                                                                              |
| S7 entry lists ×5, two export conventions          | pnpm `publishConfig.exports`, as llm already uses; workspace resolution through `exports`                                                | `packages/llm/package.json:35-48`; `validate-artifacts.mjs:33`; `check-api-report.mjs:44-49`                                                                                  |
| S8 hand-kept job lists                             | GitHub Actions `toJSON(needs)` with `jq`; `strategy.matrix.include`                                                                      | the `needs` context and matrix `include` (Actions expression syntax; `fromJson` already used at `ci.yml:274`)                                                                 |
| S9 duplicated agent steps                          | GitHub Actions composite actions, beside the three that exist                                                                            | `.github/actions/*/action.yml` (`runs.using: composite`)                                                                                                                      |
| Thin: two `walkFiles`                              | Node `fs.readdirSync(dir, { recursive: true, withFileTypes: true })`                                                                     | `node_modules/@types/node/fs.d.ts:2160` (`readdirSync`, `recursive?: boolean`)                                                                                                |
| Thin: hand-kept package list                       | Node `fs.globSync('packages/*/src')`                                                                                                     | `node_modules/@types/node/fs.d.ts:4447` (`globSync`)                                                                                                                          |
