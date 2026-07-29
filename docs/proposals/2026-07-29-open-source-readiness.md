# Open-source readiness audit

_Audited at `0.40.0` (`f7c3958`), 2026-07-29. Full history (17,585 commits),
working tree, CI, dependency graph, and build/test/lint health._

**Verdict.** The code is in good shape — typecheck and lint are clean, there
are no secrets in history, dependency licensing is clean, and there is
effectively **no dead code to remove**. What stands between here and a public
repo is almost entirely legal and product-decision work, not engineering
cleanup.

Sections are ordered by whether they block flipping the switch.

## Status

Everything that needed no decision from the maintainers has been done. What is
left is genuinely waiting on a choice.

| Item                                       | Status                                          |
| ------------------------------------------ | ----------------------------------------------- |
| §3.2 `packages/agent` repo metadata        | **Done**                                        |
| §4.1 `SECURITY.md`                         | **Done**                                        |
| §4.2 Telemetry opt-out                     | **Done** — `texra.telemetry.enabled`            |
| §4.3 `npm test` green on a clean checkout  | **Done**                                        |
| §4.5 Stale `.gitignore` comment            | **Done**                                        |
| §1 Licensing and legal                     | Blocked — needs a license choice                |
| §2 What gets published                     | Blocked — needs three product calls             |
| §3.1 Repo identity                         | Blocked — needs the final repo home             |
| §3.3 Secret scanning                       | Blocked — repo admin setting, and a timing call |
| §4.1 `CONTRIBUTING.md` / `CODE_OF_CONDUCT` | Deliberately held — see below                   |
| §4.4 `minimumReleaseAge`                   | Held — documented tradeoff, maintainer's call   |

`CONTRIBUTING.md` and `CODE_OF_CONDUCT.md` are held on purpose rather than
overlooked. Soliciting outside contributions while the repo is still "all rights
reserved" with no CLA or DCO creates exactly the IP ambiguity §1.4 warns about —
inbound patches with no clear grant, on a codebase whose copyright may later be
assigned. They should land together with the license decision, not before it.
`SECURITY.md` is different: a private path for reporting vulnerabilities is
worth having under any license, and it invites no code.

---

## 1. Blockers — licensing and legal

### 1.1 The root `LICENSE` is a placeholder

`LICENSE` is 8 bytes containing the literal word `LICENSE`. It has never been
a real license file.

### 1.2 Everything currently declares itself proprietary

Five places all say "proprietary, all rights reserved" and must agree on
whatever license is chosen:

| Where                                                 | Current state                                     |
| ----------------------------------------------------- | ------------------------------------------------- |
| `LICENSE`                                             | placeholder                                       |
| `packages/agent/LICENSE.txt`                          | "TeXRA Proprietary License … All rights reserved" |
| `packages/cli/LICENSE.txt`                            | same                                              |
| `packages/extension/LICENSE.txt`                      | same                                              |
| `license` field in the three published `package.json` | `SEE LICENSE IN LICENSE.txt`                      |
| `README.md` footer                                    | "© TeXRA Team 2025–2026. All rights reserved."    |

`packages/desktop` and `packages/trace-viewer` have no `license` field at all
(both are `private: true`, so this is lower priority, but they still ship in
the desktop installer).

### 1.3 The Terms of Service contradict an OSS license

`TERMS_OF_SERVICE.md` currently forbids exactly what an OSS license grants:

- §29 — "Modify, adapt, or create derivative works of the Service."
- §54 — "Attempt to reverse-engineer, decompile, or disassemble the Service…"
- §62 — "TeXRA is proprietary software. All rights, title, and interest in the
  Service, including its code, design, documentation, and trademarks, are
  owned by the TeXRA team…"

The TOS needs a clean split between **the Service** (hosted relay, accounts,
subscriptions — still governed by the TOS) and **the software** (this repo —
governed by the new license). Otherwise every user is under two contradictory
grants.

### 1.4 Copyright holder and contributor terms are undecided

§62 also says rights "will be assigned to any successor entity upon
incorporation." Decide the copyright line _before_ publishing, and decide
whether inbound contributions need a DCO or a CLA — you want one if there is
any chance of relicensing or assigning to a future entity. Retrofitting a CLA
after outside contributions land is painful.

Also missing: `.github/CODEOWNERS`, and the trademark position on the "TeXRA"
name/logo (the TOS reserves trademarks; an OSS license should not silently
grant them).

---

## 2. Blockers — decisions about what actually gets published

These are business calls, not defects. Each one is a thing that is private
today and becomes public the moment the repo flips.

### 2.1 Hosted-specialist system prompts (`prompts/agents/remote/`)

21 YAML files, 408 KB, containing the **full system prompts** for the
sign-in-gated hosted specialists the README markets as the paid surface —
`orchestrator`, `logic`, `notation`, `enhance`, `elevate`, `humanize`,
`devise`, `apply`, `verifyFix`, `progressCheck`, and the whole Lean line.

These are _not_ shipped in the VSIX. They live only here and are synced into
Supabase by `scripts/sync-remote-agents.mjs`. A public repo publishes them.

**Decide:** ship them (transparency, forkability) or move them to a private
repo and keep the sync script pointed there.

### 2.2 Server-side abuse controls (`supabase/`)

Publishing `supabase/functions/relay/**` publishes the enforcement design
verbatim: `requestGate.ts` (per-tier rate and concurrency limits),
`enforcement.ts` (monthly spend verification), `requestLimits.ts`, and 22 SQL
migrations including all the RLS policies. `src/auth/config.ts:129-133` also
hardcodes the tier spend caps ($10 free / $50 Max / $300 Ultra).

This is defensible — enforcement is server-side and doesn't depend on secrecy,
and the RLS migrations look correctly scoped to `service_role`. But confirm
deliberately that no control depends on obscurity before publishing, and
decide whether `supabase/` belongs in the public repo at all.

### 2.3 4.5 MB of internal design docs

145 files across `docs/prds/` (77), `docs/proposals/` (68), `docs/dev/`,
`docs/architecture/`, `docs/design/`, `docs/reference/`. They are excluded
from the texra.ai site by `docs/.vitepress/publicDocs.js`, but that only
governs the _site_ — a public repo publishes the files themselves.

They contain no secrets and no business-sensitive material (checked: the only
"revenue/margin" hits are CSS `margin`). They're genuinely good contributor
context. **Decide:** keep as-is, or split to a private repo.

---

## 3. Blockers — repo identity and hardening

### 3.1 The repo has two identities

Code lives in `lionsr/texra` (private); issues live in the separate public
`texra-ai/texra-issues`. Every published package points at the latter:

- `packages/extension/package.json` — `repository`, `bugs` → `texra-issues`
- `packages/cli/package.json` — same
- `packages/desktop/package.json` — same
- `README.md`, `docs/guide/{quick-start,installation,troubleshooting,acknowledgments,index}.md`,
  `docs/index.md`, `docs/.vitepress/config.js` — all link to `texra-issues`
- `.github/labels.yml:1` — "Source of truth for issue/PR labels on lionsr/texra"

Decide the final home, update all of the above, and plan the issue migration
so you are not running two trackers.

### 3.2 `packages/agent` has no repo metadata

**Done.** `@texra-ai/agent` is published to npm (`private: false`) and had **no**
`repository`, `bugs`, `homepage`, or `author` field — the package most likely to
be found by someone who has never heard of TeXRA. It now carries the same four
fields as the CLI and extension packages, so it moves with them when §3.1 is
settled.

### 3.3 GitHub secret scanning is off

Confirmed: the secret-scanning API returns _"Repository does not have GitHub
Advanced Security enabled."_ Turn on **secret scanning and push protection**
before flipping to public — both are free on public repositories, and push
protection is the thing that stops the first contributor accident.

---

## 4. Should do before launch

### 4.1 No community files

`SECURITY.md` — **done**. It mattered more than usual here: the project handles
user API keys, OAuth tokens, and a hosted relay, and there was no published way
to report a vulnerability privately. It names `contact@texra.ai`, scopes what is
worth reporting (credential storage, the auth flows, tool-execution approval,
prompt injection that escalates privilege, relay enforcement, webview and
renderer isolation), and tells reporters to rotate an exposed key first.

Still missing: `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `.github/ISSUE_TEMPLATE/`,
`.github/CODEOWNERS`. `.github/PULL_REQUEST_TEMPLATE.md` exists. The first two
are held until the license lands (see **Status** above); the issue templates and
CODEOWNERS depend on §3.1's repo home and on who is on the team.

When `CONTRIBUTING.md` is written: `AGENTS.md` (38 KB) is excellent contributor
material but is written for agents. The human version should point at it and
lead with the single highest-value fact in this repo — **builds do not type
check; run `npm run typecheck` or the `:safe` script variants.**

### 4.2 Telemetry has no opt-out

`src/telemetry/UsageLogService.ts` defaults to `enabled: true` and is
initialized unconditionally from both hosts
(`packages/extension/src/extension.ts:490`,
`packages/cli/src/runtime/initPlatform.ts:337`). It sends model, provider,
agent name and category, input/output/cached/reasoning token counts, cost, and
response time to `remote.texra.ai/functions/v1/log-usage`.

It only flushes when signed in — `flushQueuedBatch()` returns early without a
relay access token — but **signed-in BYOK users were logged too**
(`usedRelay: false` entries), and there was no key in
`contributes.configuration` to turn it off. Invisible in a private repo; in a
public one it is the first thing people grep for.

**Done.** `texra.telemetry.enabled` (default `true`, so no behaviour change) now
gates it, added to `CoreSettingsShape` so all three hosts pick it up: VS Code
surfaces it under **TeXRA → Privacy** at `application` scope — deliberately not
`resource`, so a workspace cannot re-enable logging a user turned off — and the
CLI and desktop read it from `.texra/config.json` via `JsonConfigProvider`, with
`KNOWN_TEXRA_KEYS` picking it up automatically from `CORE_SETTING_PATHS`.

The setting is read **live** on each queue and flush rather than snapshotted at
`initialize()`, so turning it off takes effect immediately instead of at next
launch, and the flush path discards rounds recorded before the opt-out rather
than shipping one last batch.

One trap worth remembering, since it is not obvious from the names: the discard
is gated on the user setting **alone**, never on `config.enabled`. That field is
the lifecycle gate, and `dispose()` clears it precisely so no new entry is
queued while shutdown drains the final batch. Keying the discard off it too
silently dropped the last flush on every CLI exit — and with it the relay spend
accounting. The existing "waits for successive active batches during disposal"
test catches this; it is not redundant.

Reading the setting adds a `telemetry -> platform` subsystem edge, which the
LAY-1 ratchet correctly flagged as new. It is accepted and recorded in
`config/ratchets/architecture-edges-baseline.json`: reaching host config through
the `platform()` port is the sanctioned mechanism, and it is the same edge
`src/tools/goal/goalFeatureFlag.ts` already relies on for its feature flag.

Documented for users in `docs/guide/configuration.md` under "Usage Logging",
including the fact that disabling it also stops hosted spend accounting.

### 4.3 `npm test` is not green on a clean checkout

**Done.** 3 failures out of 7,965 (796 of 800 files passed). CI on `main` is
green, so all three were specific to a sandboxed or loaded machine — but a
first-time contributor still ran `npm test` and saw red.

| Test                                                        | Cause                                                      | Fix                     |
| ----------------------------------------------------------- | ---------------------------------------------------------- | ----------------------- |
| `src/test-kernel/desktop/DesktopDevScript.vitest.mts`       | `require('electron')` downloads the binary on demand       | made hermetic           |
| `src/test-kernel/agent/WorkflowScriptEngine.vitest.ts:1741` | wall-clock assertion `< 3000 ms`; took 9,349 ms under load | budget widened          |
| `src/test-kernel/utils/system/SystemUtils.vitest.ts:224`    | 1 s budget for process-group teardown                      | budget widened to ~10 s |

The Electron one was the interesting case. Electron 43 dropped its `postinstall`
script — `require('electron')` now _downloads_ the platform binary the first
time it is called. So `dev.mjs`'s module-level require turned a unit test into a
network fetch on a fresh checkout, and a hard failure with no network. Rather
than skip it, the test now sets `ELECTRON_OVERRIDE_DIST_PATH`, which
short-circuits that resolution. No coverage is lost: the assertions only check
the spawn arguments, env, and stdio, never the binary's location. The test is
now hermetic everywhere instead of quietly depending on the network in CI.

The other two are pure hang guards, not latency measurements — the memory test's
containment is already proven by its `/memory/` rejection (a failure of the
memory limit would reject with `/timed out/` instead), so a tight wall-clock
bound there bought nothing and flaked whenever the suite saturated every core.

### 4.4 Supply-chain quarantine is disabled repo-wide

`pnpm-workspace.yaml` sets `minimumReleaseAge: 0`, turning off pnpm 11's
24-hour quarantine, while `.github/dependabot.yml` opens grouped dependency PRs
daily. The comment explains the tradeoff (same-day `llm-zoo` bumps for new
models), which was reasonable while private. A public, higher-profile repo
raises the value of that window — consider scoping the override to the
packages that actually need it.

### 4.5 A stale comment invents a private dependency

**Done.** `.gitignore` claimed _"CI checks out a private trusted-actions repo
here at runtime; never commit it."_ It doesn't. The `.trusted-actions` checkout
in `claude.yml`, `claude-code-review.yml`, and `issue-tracker.yml` has no
`repository:` field — it is a second checkout of _this_ repo at the PR's base
ref, so the automation prompts and tool allowlists come from trusted committed
history rather than the branch under review. Outside readers would have hunted
for a private repo that does not exist; the comment now says what it is for.

---

## 5. Verified clean — do not re-audit

Recorded so this work isn't repeated.

**Secrets.** Scanned all ~74,000 blobs in the full 17,585-commit history for
OpenAI, Anthropic, GitHub (PAT/OAuth/App), AWS, Google, Slack, GitLab, npm,
Supabase, and HuggingFace key formats plus PEM private keys: **zero hits.**

The single JWT in history is a Supabase **anon** key (project ref
`jntubmcgbhwtcktubelv`, `role: anon`) that used to sit in `src/auth/config.ts`
and has since been replaced by `sb_publishable_…`. Anon and publishable keys
are public by design and already ship in every VSIX. **No rotation or history
rewrite is required.** No `service_role` key appears anywhere.

Working tree is also clean: no credentials, no gitignored-but-tracked files, no
real user data, no local author paths, no `.npmrc` with a private registry.

**Dependency licensing.** 3,162 resolved packages: 2,349 MIT, 239 Apache-2.0,
194 ISC, 114 BSD-3, 90 BSD-2, 50 0BSD, 41 BlueOak, remainder permissive.
**Zero GPL / AGPL / SSPL / BUSL / Commons Clause.** The only weak copyleft is
MPL-2.0 (`lightningcss`, and `dompurify` which is dual MPL/Apache) — file-level
and fine for unmodified use. No vendored third-party source anywhere.

**CI is already fork-safe.** `claude.yml`, `claude-code-review.yml`, and
`issue-tracker.yml` all gate on
`author_association ∈ {OWNER, MEMBER, COLLABORATOR}` plus a `vars.*_ENABLED`
kill switch, so a drive-by `@claude` comment from a stranger cannot trigger a
run with write permissions. The one `pull_request_target` workflow
(`auto-label.yml`) never checks out PR code and passes the untrusted PR title
through `env:` rather than inline `${{ }}` interpolation — the correct pattern.

**Code health.** `npm run typecheck` clean across all six projects.
`npm run lint` clean. Git history is 76 MB with no large binaries (biggest blob
is a 4.25 MB vision notebook).

**Dead code: nothing to remove.** knip reports 2 unused files and 15 unused
exports; every one is an indirection false positive, and all are already in
`config/ratchets/knip-baseline.json`:

- `src/test-kernel/support/setupFakePlatform.ts` — it _is_ vitest's
  `setupFiles` entry (`vitest.config.mjs:28`); knip doesn't parse that field.
- `packages/trace-viewer/vite.standalone.config.ts` — invoked by that
  package's own `build` script.
- The 7 `packages/extension/src/frontend/lean/VscodeIntegration.ts` exports —
  reached through namespace injection,
  `setLeanLanguageServices(leanVscodeIntegration)` at
  `packages/extension/src/extension.ts:531`.
- The rest are desktop test hooks and warning constants.

Three scripts that look orphaned (`scripts/deploy-relay.mjs`,
`scripts/esm-cjs-globals-banner.mjs`,
`scripts/prune-desktop-codex-payload.mjs`) are all referenced — from
`docs/supabase/RELAY_SETUP.md`, the cli/desktop esbuild configs, and
`electron-builder.yml`'s `afterPack` respectively.

**One real gap, but not dead code.** `knip.json` sets
`"ignoreDependencies": [".*"]`, so unused dependencies are ungated. Lifting it
surfaces 113 "unused" deps, but they are workspace-hoisting artifacts, not
dead: `dotenv`, `fs-extra`, `mark.js`, and `minimatch` are declared in the root
`package.json` yet imported only from `packages/extension`, and nearly all of
`packages/agent`'s list is re-exported core that knip can't trace across the
alias boundary. Nothing to delete — worth tidying the declarations if the
`@texra/core` package ever lands.

---

## Suggested order

What remains, all of it downstream of a decision:

1. Pick the license → rewrite `LICENSE`, the three `LICENSE.txt`, all
   `license` fields, and the README footer. (§1.1, §1.2)
2. Split the TOS into Service vs. Software; settle the copyright line and
   DCO/CLA. (§1.3, §1.4)
3. Decide `prompts/agents/remote/`, `supabase/`, and internal `docs/`. (§2)
4. Settle the repo home; fix every `repository`/`bugs` link; migrate issues. (§3.1)
5. Enable secret scanning + push protection. (§3.3)
6. Once 1–2 land: `CONTRIBUTING.md` and `CODE_OF_CONDUCT.md`. Once 4 lands:
   issue templates and `CODEOWNERS`. (§4.1)
7. Revisit `minimumReleaseAge` at whatever profile the project ends up with.
   (§4.4)

Steps 1–5 gate the flip. Step 1 unblocks the most: it is the only thing 6
waits on, and the licence text is the last piece of the repo that still says
the opposite of what you intend.
