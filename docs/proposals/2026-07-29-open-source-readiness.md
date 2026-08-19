# Open-source readiness audit

> **Superseded in part by [`2026-08-01-open-source-readiness-audit.md`](./2026-08-01-open-source-readiness-audit.md).**
> That audit disproves three conclusions below: that no history rewrite is
> required (confidential third-party peer-review correspondence is reachable
> from 154 of 208 tags under `agents/prl/`), that there is no vendored
> third-party source, and the telemetry-opt-out status. The licensing and
> product sections here remain current.

_Audited at `0.40.0` (`f7c3958`), 2026-07-29: full history (17,585 commits),
working tree, CI, dependency graph, build/test/lint health._

Typecheck and lint are clean, there are no secrets in history, dependency
licensing is clean, and there is no dead code to remove. What remains is
licensing and product decisions, not engineering cleanup.

## Status

| Item                                       | Status                            |
| ------------------------------------------ | --------------------------------- |
| §1 Licensing and legal                     | Needs a license choice            |
| §2 What gets published                     | Needs three product calls         |
| §3.1 Repo identity                         | Needs the final repo home         |
| §3.2 `packages/agent` repo metadata        | Done                              |
| §3.3 Secret scanning                       | Repo admin setting                |
| §4.1 `SECURITY.md`                         | Done                              |
| §4.1 `CONTRIBUTING.md` / `CODE_OF_CONDUCT` | Held until the license lands      |
| §4.2 Telemetry opt-out                     | Done — `texra.telemetry.enabled`  |
| §4.3 `npm test` green on a clean checkout  | Done                              |
| §4.4 `minimumReleaseAge`                   | Open — documented tradeoff        |
| §4.5 Stale `.gitignore` comment            | Done                              |
| §4.6 CI runs only on Linux                 | Blocked — ~10 Windows failures    |
| §4.7 Windows tool discovery                | Done — Ghostscript, TeX Live Perl |

`CONTRIBUTING.md` and `CODE_OF_CONDUCT.md` are held rather than skipped.
Soliciting contributions under "all rights reserved" with no CLA or DCO creates
the IP ambiguity described in §1.4. `SECURITY.md` is not held: a private
reporting path is useful under any license and invites no code.

---

## 1. Licensing and legal

### 1.1 The root `LICENSE` is a placeholder

`LICENSE` is 8 bytes containing the literal word `LICENSE`.

### 1.2 Everything declares itself proprietary

Six places must agree on whatever license is chosen:

| Where                                                 | Current state                                     |
| ----------------------------------------------------- | ------------------------------------------------- |
| `LICENSE`                                             | placeholder                                       |
| `packages/agent/LICENSE.txt`                          | "TeXRA Proprietary License … All rights reserved" |
| `packages/cli/LICENSE.txt`                            | same                                              |
| `packages/extension/LICENSE.txt`                      | same                                              |
| `license` field in the three published `package.json` | `SEE LICENSE IN LICENSE.txt`                      |
| `README.md` footer                                    | "© TeXRA Team 2025–2026. All rights reserved."    |

`packages/desktop` and `packages/trace-viewer` have no `license` field. Both are
`private: true`, but they ship in the desktop installer.

### 1.3 The Terms of Service contradict an OSS license

`TERMS_OF_SERVICE.md` forbids what an OSS license grants:

- §29 — "Modify, adapt, or create derivative works of the Service."
- §54 — "Attempt to reverse-engineer, decompile, or disassemble the Service…"
- §62 — "TeXRA is proprietary software. All rights, title, and interest in the
  Service, including its code, design, documentation, and trademarks, are
  owned by the TeXRA team…"

The TOS needs a split between the Service (hosted relay, accounts,
subscriptions — still governed by the TOS) and the software (this repo —
governed by the new license). Otherwise users are under two contradictory
grants.

### 1.4 Copyright holder and contributor terms are undecided

§62 says rights "will be assigned to any successor entity upon incorporation."
Settle the copyright line before publishing, and decide whether inbound
contributions need a DCO or a CLA. A CLA is hard to retrofit once outside
contributions have landed, and relicensing or assigning to a future entity
needs one.

Also open: `.github/CODEOWNERS`, and the trademark position on the TeXRA
name and logo. The TOS reserves trademarks; an OSS license should not grant
them implicitly.

---

## 2. What gets published

Business calls, not defects. Each is private today and becomes public when the
repo flips.

### 2.1 Hosted-specialist system prompts (`prompts/agents/remote/`)

21 YAML files, 408 KB, holding the system prompts for the sign-in-gated hosted
specialists the README markets as the paid surface: `orchestrator`, `logic`,
`notation`, `enhance`, `elevate`, `humanize`, `devise`, `apply`, `verifyFix`,
`progressCheck`, and the Lean line.

They are not shipped in the VSIX. They exist only here and are synced into
Supabase by `scripts/sync-remote-agents.mjs`.

Decide: publish them, or move them to a private repo and repoint the sync
script.

### 2.2 Server-side abuse controls (`supabase/`)

Publishing `supabase/functions/relay/**` publishes the enforcement design:
`requestGate.ts` (per-tier rate and concurrency limits), `enforcement.ts`
(monthly spend verification), `requestLimits.ts`, and 22 SQL migrations
including the RLS policies. `src/auth/config.ts:129-133` hardcodes the tier
spend caps ($10 free / $50 Max / $300 Ultra).

Enforcement is server-side and does not depend on secrecy, and the RLS
migrations are scoped to `service_role`. Before publishing, confirm no control
depends on obscurity, and decide whether `supabase/` belongs in the public repo
at all.

### 2.3 4.5 MB of internal design docs

145 files across `docs/prds/` (77), `docs/proposals/` (68), `docs/dev/`,
`docs/architecture/`, `docs/design/`, `docs/reference/`. `publicDocs.js`
excludes them from the texra.ai site, but that governs the site only — a public
repo publishes the files.

They contain no secrets and no business-sensitive material; the only
"revenue/margin" hits are CSS `margin`. Decide: keep, or split to a private
repo.

---

## 3. Repo identity and hardening

### 3.1 The repo has two identities

Code lives in `lionsr/texra` (private); issues live in the separate public
`texra-ai/texra-issues`. Every published package points at the latter:

- `packages/extension/package.json` — `repository`, `bugs` → `texra-issues`
- `packages/cli/package.json` — same
- `packages/desktop/package.json` — same
- `README.md`, `docs/guide/{quick-start,installation,troubleshooting,acknowledgments,index}.md`,
  `docs/index.md`, `docs/.vitepress/config.js` — all link to `texra-issues`
- `.github/labels.yml:1` — "Source of truth for issue/PR labels on lionsr/texra"

Settle the final home, update all of the above, and plan the issue migration so
there is only one tracker.

### 3.2 `packages/agent` has no repo metadata

Done. `@texra-ai/agent` is published to npm (`private: false`) and had no
`repository`, `bugs`, `homepage`, or `author` field. It now carries the same
four as the CLI and extension packages, so it moves with them when §3.1 is
settled.

### 3.3 GitHub secret scanning is off

The secret-scanning API returns "Repository does not have GitHub Advanced
Security enabled." Turn on secret scanning and push protection before flipping
to public. Both are free on public repositories, and push protection is what
stops the first contributor accident.

---

## 4. Should do before launch

### 4.1 Community files

`SECURITY.md` — done. The project handles user API keys, OAuth tokens, and a
hosted relay, and had no published way to report a vulnerability privately. It
names `contact@texra.ai` and scopes what is worth reporting: credential
storage, the auth flows, tool-execution approval, prompt injection that
escalates privilege, relay enforcement, and webview/renderer isolation.

Still missing: `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`,
`.github/ISSUE_TEMPLATE/`, `.github/CODEOWNERS`.
`.github/PULL_REQUEST_TEMPLATE.md` exists. The first two wait on the license;
the issue templates and CODEOWNERS wait on §3.1 and on team membership.

For `CONTRIBUTING.md`: `AGENTS.md` (38 KB) is good contributor material but is
written for agents. The human version should point at it and lead with the fact
that builds do not type check — `npm run typecheck`, or the `:safe` script
variants.

### 4.2 Telemetry had no opt-out

`src/telemetry/UsageLogService.ts` defaulted to `enabled: true` and was
initialized unconditionally from both hosts
(`packages/extension/src/extension.ts:490`,
`packages/cli/src/runtime/initPlatform.ts:337`). It sends model, provider,
agent name and category, input/output/cached/reasoning token counts, cost, and
response time to `remote.texra.ai/functions/v1/log-usage`.

It only flushes when signed in — `flushQueuedBatch()` returns early without a
relay access token — but signed-in BYOK users were logged too (`usedRelay:
false` entries), and no key in `contributes.configuration` turned it off.

Done. `texra.telemetry.enabled` (default `true`, so no behaviour change) gates
it. It lives in `CoreSettingsShape`, so all three hosts pick it up. VS Code
shows it under TeXRA → Privacy at `application` scope, not `resource`, so a
workspace cannot re-enable logging a user turned off. The CLI and desktop read
it from `.texra/config.json` through `JsonConfigProvider`, and
`KNOWN_TEXRA_KEYS` derives it from `CORE_SETTING_PATHS`.

The setting is read on each queue and flush rather than snapshotted at
`initialize()`, so turning it off applies immediately and the flush path
discards rounds recorded before the opt-out instead of sending a final batch.

The discard is gated on the user setting alone, not on `config.enabled`.
`config.enabled` is the lifecycle gate: `dispose()` clears it so no new entry is
queued while shutdown drains the last batch. Gating the discard on it as well
drops that flush on every CLI exit, and the relay spend accounting with it. The
"waits for successive active batches during disposal" test covers this.

Reading the setting adds a `telemetry -> platform` subsystem edge, now recorded
in `config/ratchets/architecture-edges-baseline.json`. Host config is reached
through the `platform()` port; `src/tools/goal/goalFeatureFlag.ts` uses the same
edge for its feature flag.

Rounds that ran through the relay or a subscription are exempt from the opt-out:
the relay enforces the monthly spend cap from the aggregate those records
populate, so suppressing them would let hosted calls run against a stale total.
What the opt-out governs is `api-key` rounds, which cost TeXRA nothing.

`TEXRA_NO_TELEMETRY=1` and the cross-tool `DO_NOT_TRACK=1` do the same thing
from the environment, overriding the setting in one direction only — neither can
turn logging back on. Both go through `isEnvFlagEnabled`
(`src/utils/system/envFlags.ts`), which is now also how `TEXRA_NO_UPDATE_CHECK`
and `TEXRA_DISABLE_KEYCHAIN` are read, so `=0` means off everywhere instead of
only in the hosts that happened to test for it.

User documentation is in `docs/guide/configuration.md` under "Usage Logging"
and in `docs/guide/texra-cli.md` under the environment-only switches.

### 4.3 `npm test` was not green on a clean checkout

Done. 3 failures out of 7,965 (796 of 800 files passed). CI on `main` was green,
so all three were specific to a sandboxed or loaded machine.

| Test                                                     | Cause                                                      | Fix                                 |
| -------------------------------------------------------- | ---------------------------------------------------------- | ----------------------------------- |
| `src/test-kernel/desktop/DesktopDevScript.vitest.mts`    | `require('electron')` downloads the binary on demand       | made hermetic                       |
| `src/test-kernel/agent/WorkflowScriptEngine.vitest.ts`   | wall-clock assertion `< 3000 ms`; took 9,349 ms under load | assertion removed, per-test timeout |
| `src/test-kernel/utils/system/SystemUtils.vitest.ts:224` | 1 s budget for process-group teardown                      | ~10 s budget, per-test timeout      |

Electron 43 dropped its `postinstall`; `require('electron')` now downloads the
platform binary on first call. `dev.mjs` requires it at module load, so the test
performed a network fetch on a fresh checkout and failed outright without
network. It now sets `ELECTRON_OVERRIDE_DIST_PATH`, which short-circuits that
resolution. The assertions cover spawn arguments, env, and stdio, not the binary
path, so no coverage is lost.

The other two were wall-clock bounds standing in as hang guards. Both needed a
per-test timeout to have any effect at all, because `vitest.config.mjs` sets
`testTimeout: 10000` and the widened bounds exceeded it — the runner aborted the
test before the assertion could run, so the first attempt at this traded an
assertion failure for a timeout failure.

The memory test then lost its bound entirely. Containment is established by its
`/memory/` rejection (a failure of the memory limit rejects with `/timed out/`
instead), and filling the guest heap 1 MB at a time took 78 s during a
full-suite run on a contended machine — so any bound tight enough to mean
something is a bound the test trips over. The per-test timeout is the hang
guard; a redundant assertion measuring machine load is not.

### 4.4 Supply-chain quarantine is disabled repo-wide

`pnpm-workspace.yaml` sets `minimumReleaseAge: 0`, turning off pnpm 11's 24-hour
quarantine, while `.github/dependabot.yml` opens grouped dependency PRs daily.
The comment explains the tradeoff: same-day `llm-zoo` bumps for new models. A
higher-profile public repo raises the value of that window. Consider scoping the
override to the packages that need it.

### 4.5 A stale comment invents a private dependency

Done. `.gitignore` claimed "CI checks out a private trusted-actions repo here at
runtime; never commit it." The `.trusted-actions` checkout in `claude.yml`,
`claude-code-review.yml`, and `issue-tracker.yml` has no `repository:` field —
it is a second checkout of this repo at the PR's base ref, so automation prompts
and tool allowlists come from committed history rather than the branch under
review. The comment now says that.

---

### 4.6 CI only ever runs on Linux

Superseded — the matrix landed in #9903, then became opt-in. See "Where this
ended up" at the end of this section; the findings below are the original
attempt-and-revert record that #9903 worked from.

Every `ci.yml` job is `ubuntu-latest` except the macOS webview smoke, so none of
the platform-specific code is exercised: tool discovery under `Program Files`,
the Perl lookups, path normalization, the CLI's `win32` branches. That is how a
Ghostscript path list frozen at 9.x and a missing TeX Live Perl directory both
survived — no test covered them and no runner ran them.

Adding `windows-latest` to the sharded kernel-test matrix works, and immediately
surfaced **~10 pre-existing Windows failures** (both Linux shards, static checks,
build, and the macOS smoke stayed green). In three buckets:

| Bucket                 | Where                                                                            | Nature                                                                                   |
| ---------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Separator expectations | `CompiledPdfArtifacts.vitest.ts` ×5, `RunStorageEntryInspection.vitest.ts:202`   | `output\r2\paper.pdf` vs `output/r2/paper.pdf`; needs a decision on where to normalize   |
| Fake-filesystem gaps   | `RunStorageEntryInspection.vitest.ts:77,135,156`, `ExecutionLease.vitest.ts:619` | symlinks report `kind: 'missing'`; chmod-based permission-denied simulation is a no-op   |
| Real product bug       | `CompiledPdfArtifacts.vitest.ts:194,232,277`                                     | artifact paths carry a **duplicated run segment**: `output\r4\r4\sections\main-diff.pdf` |

The third bucket is the reason this was reverted rather than merged: it is a
genuine path-joining defect on Windows, not a test artifact, and it wants its own
change with someone who can iterate against a Windows runner. Landing a gating
job that cannot pass would have wedged every PR; making it non-gating would have
been the silent-degradation antipattern.

Still Linux-only regardless: build, lint, typecheck, and the docs build. Those
are platform-independent enough not to need duplicating.

**Where this ended up.** #9903 (2026-08-09) fixed all three buckets — including
the duplicated-run-segment defect — and restored `windows-latest` as a gating
leg of the kernel-test matrix. It gated for one day. On a representative PR run
the Windows shards took ~16 min each against ~10 min for Linux, making them the
wall-clock for the entire workflow (~16.5 min end to end) at 2x the per-minute
rate, while `static checks`, `build`, and the macOS smoke all finished inside
6 min. Windows is now **opt-in via `workflow_dispatch`** rather than gating: the
matrix expression in the `test` job adds `windows-latest` only for manual runs,
so the leg is one Actions-tab dispatch away when touching path handling or
cutting a release, and costs nothing per PR. The path fixes from #9903 remain in
the product; what lapsed is the per-PR regression signal guarding them.

### 4.7 Windows tool discovery was frozen to specific versions

Done. Two instances of the same bug, both found by reading the Windows probe
list rather than by any test:

- **Ghostscript** was six hardcoded `gs9.54`–`gs9.56` directories, so a current
  10.x install was invisible unless already on `PATH`. Now globbed, with the 9.x
  preference order preserved.
- **TeX Live's Perl** (`tlpkg/tlperl/bin`) was not probed at all, so
  `checkCoreDependencies()` reported Perl missing on a TeX Live box and the
  Setup Wizard asked for Strawberry Perl the user did not need. `latexindent`
  and `latexdiff` were unaffected — they resolve to the `.exe` wrappers under
  `texlive/*/bin/*`, which use tlperl internally.

Neither is covered by a test: `getExtraDirs()` takes no injection and caches at
module scope, so exercising the win32 branch means faking `process.platform`,
`globSync`, and the filesystem, and the assertion would restate the glob. §4.6
is the real mitigation.

## 5. Verified clean

Recorded so this is not repeated.

**Secrets.** Scanned all ~74,000 blobs in the full 17,585-commit history for
OpenAI, Anthropic, GitHub (PAT/OAuth/App), AWS, Google, Slack, GitLab, npm,
Supabase, and HuggingFace key formats plus PEM private keys: zero hits.

The one JWT in history is a Supabase anon key (project ref
`jntubmcgbhwtcktubelv`, `role: anon`) that sat in `src/auth/config.ts` and has
since been replaced by `sb_publishable_…`. Anon and publishable keys are public
by design and already ship in every VSIX, so no rotation or history rewrite is
required. No `service_role` key appears anywhere.

The working tree is clean too: no credentials, no gitignored-but-tracked files,
no real user data, no local author paths, no `.npmrc` with a private registry.

**Dependency licensing.** 3,162 resolved packages: 2,349 MIT, 239 Apache-2.0,
194 ISC, 114 BSD-3, 90 BSD-2, 50 0BSD, 41 BlueOak, remainder permissive. Zero
GPL, AGPL, SSPL, BUSL, or Commons Clause. The only weak copyleft is MPL-2.0
(`lightningcss`, and `dompurify` which is dual MPL/Apache), which is file-level
and fine for unmodified use. No vendored third-party source.

**CI is fork-safe.** `claude.yml`, `claude-code-review.yml`, and
`issue-tracker.yml` gate on
`author_association ∈ {OWNER, MEMBER, COLLABORATOR}` plus a `vars.*_ENABLED`
kill switch, so a drive-by `@claude` comment cannot trigger a run with write
permissions. The one `pull_request_target` workflow (`auto-label.yml`) never
checks out PR code and passes the untrusted PR title through `env:` rather than
inline `${{ }}` interpolation.

**Code health.** `npm run typecheck` clean across all six projects, `npm run
lint` clean. Git history is 76 MB with no large binaries; the biggest blob is a
4.25 MB vision notebook.

**Dead code: nothing to remove.** knip reports 2 unused files and 15 unused
exports. Each is an indirection false positive, and all are in
`config/ratchets/knip-baseline.json`:

- `src/test-kernel/support/setupFakePlatform.ts` is vitest's `setupFiles` entry
  (`vitest.config.mjs:28`), a field knip does not parse.
- `packages/trace-viewer/vite.standalone.config.ts` is invoked by that package's
  `build` script.
- The 7 `packages/extension/src/frontend/lean/VscodeIntegration.ts` exports are
  reached through namespace injection —
  `setLeanLanguageServices(leanVscodeIntegration)` at
  `packages/extension/src/extension.ts:531`.
- The rest are desktop test hooks and warning constants.

Three scripts that look orphaned — `scripts/deploy-relay.mjs`,
`scripts/esm-cjs-globals-banner.mjs`, `scripts/prune-desktop-codex-payload.mjs` —
are referenced from `docs/supabase/RELAY_SETUP.md`, the cli/desktop esbuild
configs, and `electron-builder.yml`'s `afterPack` respectively.

**Dependency declarations, not dead code.** `knip.json` sets
`"ignoreDependencies": [".*"]`, so unused dependencies are ungated. Lifting it
surfaces 113 "unused" deps, but they are workspace-hoisting artifacts:
`dotenv`, `fs-extra`, and `minimatch` are declared in the root
`package.json` but imported only from `packages/extension`, and most of
`packages/agent`'s list is re-exported core that knip cannot trace across the
alias boundary. Nothing to delete; worth tidying if a `@texra/core` package ever
lands.

---

## Order

Everything below is downstream of a decision.

1. Pick the license; rewrite `LICENSE`, the three `LICENSE.txt`, all `license`
   fields, and the README footer. (§1.1, §1.2)
2. Split the TOS into Service and Software; settle the copyright line and
   DCO/CLA. (§1.3, §1.4)
3. Decide `prompts/agents/remote/`, `supabase/`, and internal `docs/`. (§2)
4. Settle the repo home; fix every `repository`/`bugs` link; migrate issues.
   (§3.1)
5. Enable secret scanning and push protection. (§3.3)
6. After 1–2: `CONTRIBUTING.md` and `CODE_OF_CONDUCT.md`. After 4: issue
   templates and `CODEOWNERS`. (§4.1)
7. Revisit `minimumReleaseAge`. (§4.4)

Steps 1–5 gate the flip. Step 1 also unblocks step 6.
