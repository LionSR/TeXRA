# TeXRA Open-Source Readiness Plan

> **Supersedes in part [`2026-07-29-open-source-readiness.md`](./2026-07-29-open-source-readiness.md)** for history-rewrite, vendored-source, and telemetry-opt-out conclusions. Other conclusions in the older audit remain live.

Synthesis of eleven parallel audits plus an adversarial verification pass. The original evidence
was collected against `10ffd138365eab7fc0a03be40d2b33337a794267`; landed-status and current-path
claims were reconciled for this PR against latest `main` at PR #9539's merge commit
`37dd55eebe740a8c33f56db9cd1e238eb8ab8204`. Every claim below carries a file path or symbol;
refuted claims are collected in §6 so they do not get re-litigated.

---

## 1. Verdict

**No — not as-is, and not with this git history.** Two things make a visibility flip today
actively harmful rather than merely premature: the object at
`v0.15.10:agents/prl/example_rebuttal_package.txt` contains confidential third-party
peer-review correspondence and is reachable from 154 of 208 release tags; and three separate
pieces of MIT-licensed third-party code (`src/agent/node/index.ts`,
`packages/extension/resources/agents/write/beamerthemeconfposter.sty`,
`@fortawesome/free-solid-svg-icons`) ship in the Marketplace VSIX and the signed desktop
installers with their copyright notices stripped or absent — a live violation that publication
merely makes greppable.

**The single biggest decision, before anything else: choose the license _and_ the repo boundary
together.** `LICENSE` is 8 bytes containing the word `LICENSE` (`wc -c LICENSE` → 8), while
`packages/{extension,cli,agent}/LICENSE.txt:1-3` say "All rights reserved" and
`docs/package.json:22` says `"license": "MIT"`. Nothing else can be sequenced until that is
settled, because it gates the SXKDZ consent email, the NOTICE file, the CONTRIBUTING copy, and
whether `supabase/` ships at all. The good news: this repo is in unusually good shape
underneath — 8,170 tests pass on a cold clone, `typecheck`/`lint`/`format:check` are clean,
history contains **zero** leaked credentials across a full 219,097-object scan. A metadata-only
scan of the 735 packages at npm's current `latest` dist-tags found no
GPL/AGPL/SSPL/BUSL declarations, but it did **not** inspect the exact npm versions in
`pnpm-lock.yaml` or the Deno/JSR graph. Exact-version npm and Deno/JSR license review is therefore
a launch prerequisite. Section 2 contains five discrete blockers, not a rewrite; they are not an
exhaustive launch checklist. Additional publication and launch gates are called out separately in
§4 and sequenced in §7.

---

## 2. Blockers

Ordered by real-world consequence. All five §2 blockers must close before the visibility flip.
They are necessary but not sufficient: the additional publication and launch gates in §4 and §7
must also pass.

### B1 — Confidential third-party peer-review correspondence in published git history

|                                      |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Evidence**                         | Object-path evidence only: `v0.15.10:agents/prl/example_rebuttal_package.txt` and `7a02f5cd1:agents/prl/reply_to_editor.tex`. Both contain confidential third-party peer-review correspondence. No names, manuscript identifiers, or excerpts are reproduced here.                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **Reach**                            | `git tag --contains 88b08e626` → **154 of 208 tags**; `git branch -r --contains` → 33 branches. `origin/backend` (tip `e648bf58e`, 2024-11-11) carries `agents/prl/example_rebuttal_letter.txt` independently, so a tag-only purge misses it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **Why blocker**                      | Peer-review reports and editorial correspondence are confidential; publication requires consent that is not evidenced in the repository. This is not hygiene.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **Why the existing audit missed it** | `docs/proposals/2026-07-29-open-source-readiness.md` states "no rotation or history rewrite is required" and scopes its clean bill to "The working tree". The recorded scan matched credential _formats_, not prose. `docs/proposals/2026-07-24-open-source-release.md` sets the correct gate ("a secret and personal-data scan passes on both the release tree and the history being published") — it has provably not run.                                                                                                                                                                                                                                                                                       |
| **Fix**                              | Run `git filter-repo --invert-paths` over a **fresh `git clone --mirror`** (this checkout is shallow — `.git/shallow` exists), removing `--path-glob 'agents/*'` at minimum and removing every historical version of `docs/proposals/2026-08-01-open-source-readiness-audit.md`; re-add only this redacted audit after the rewrite. Delete or rewrite `origin/backend` in the same pass. Verify the confidential object paths and the pre-redaction audit object are absent from `git rev-list --objects --all`, then inspect rewritten blobs without printing their contents. **Ref deletion is not an acceptable fallback** — GitHub keeps unreachable objects fetchable by SHA at `/commit/<sha>` indefinitely. |
| **Cost of delay**                    | Zero-cost today: GitHub API for this repo returns `"private":true, "forks_count":0, "stargazers_count":0` — nothing external can break. After the flip, a rewrite strands every SHA anyone has linked and forces a hard reset on every cloner. **The window closes at the flip.**                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **Effort**                           | Hours (one maintenance window). Free riders in the same pass: `coauthor-python/prototypes/`, `Notebooks/` (4 verbatim Anthropic Cookbook notebooks, 10 blobs, largest object in the pack at 4,458,316 B), `*.vsix` (141 blobs).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

### B2 — `src/agent/node/index.ts` is an unattributed derivative of MIT-licensed PocketFlow-Typescript, already shipping

|                        |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Evidence**           | Diffed against `The-Pocket/PocketFlow-Typescript` `src/index.ts` (MIT, © 2025 Victor Duarte and Zachary Huang). Verbatim carryover at `src/agent/node/index.ts:62` (`Node won't run successors. Use Flow.`), `:75`, `:85`, `:95-100` (`clone()` incl. the `clonedNode` local), `:233-241` (`_orchestrate` line-for-line, only `setParams(p)` → `setServices(...)`), `:249` (`throw new Error("Flow can't exec.")`), and an identical export list at `:252`. Independently corroborating: `:8` hardcodes `const CHANNEL = 'PocketFlow'`. |
| **Attribution status** | Zero SPDX hits across 2,140 non-dist `.ts`/`.tsx` files. No `NOTICE`/`THIRD-PARTY-*` file exists anywhere. `docs/guide/acknowledgments.md` credits Prompt Poet (line 37) but never PocketFlow. `AGENTS.md:403-404` acknowledges descent in prose — which does not satisfy MIT's notice-retention clause.                                                                                                                                                                                                                                |
| **Why blocker**        | MIT requires the copyright and permission notice "be included in all copies or substantial portions". TeXRA distributes this file **today** in the Marketplace VSIX and the signed desktop installers with no notice. It is an ongoing violation against a named third party, and the exact string `Flow can't exec.` is a one-line search.                                                                                                                                                                                             |
| **Fix**                | Add upstream MIT text + "Copyright (c) 2025 Victor Duarte and Zachary Huang" to a `NOTICE` / `THIRD-PARTY-LICENSES` file; add a provenance header to `src/agent/node/index.ts`. **Ensure it ships**: `scripts/verify-extension-package-invariants.mjs:42` currently lists only `'LICENSE.txt'` in `REQUIRED_PACKAGED_PATHS`, and `packages/desktop/electron-builder.yml:29-41` ships no legal file at all. Also correct `docs/proposals/2026-07-29-open-source-readiness.md` ("No vendored third-party source.").                       |
| **Not required**       | `CLAUDE.md:138` needs **no** correction — it is scoped to API surface (ruling out upstream's `BatchNode`/`params` channel), not provenance. MIT is compatible with any license you choose; this costs a notice, not a relicense.                                                                                                                                                                                                                                                                                                        |
| **Effort**             | Hours.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

### B3 — A stripped-attribution MIT beamer theme ships inside the "All rights reserved" VSIX

|                 |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Evidence**    | `packages/extension/resources/agents/write/beamerthemeconfposter.sty:1-11` is `anishathalye/gemini`'s `beamerthemegemini.sty:4-13` byte-for-byte **with the two attribution lines `% Gemini theme` / `% https://github.com/anishathalye/gemini` deleted**. Downstream matches: `\newcommand{\samelineand}{\qquad}`, `\heading`, the `headline title/author/institute` font set, the three itemize `\vrule width 0.5ex height 0.5ex` templates. `beamercolorthemempi.sty` is gemini's companion colortheme renamed — it sets gemini-only keys `headline rule` (:32), `block separator` (:40), `block alerted separator` (:45). gemini is MIT (© Anish Athalye). |
| **Ships today** | Referenced by `template_poster.tex:4-5` (`\usetheme{confposter}` / `\usecolortheme{mpi}`) and `paper2poster.yaml`; not excluded by `packages/extension/.vscodeignore`. No credit in `docs/guide/acknowledgments.md`. Git provenance is unrecoverable — `git log --diff-filter=A` on the directory returns a single unrelated 2026 commit.                                                                                                                                                                                                                                                                                                                      |
| **Why blocker** | This is worse than B2: the attribution comment was present upstream and is absent locally, and the file sits inside a package whose `LICENSE.txt:1-3` reads "TeXRA is proprietary software. All rights reserved." A LaTeX-literate audience notices this on day one.                                                                                                                                                                                                                                                                                                                                                                                           |
| **Fix**         | Restore the upstream header + gemini's MIT text in both `.sty` files, add an `acknowledgments.md` entry, and fold into the same NOTICE file as B2. Do the same provenance check on `template_poster.tex` and `template_slide.tex` (unaudited).                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **Effort**      | Hours.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

### B4 — workflow hardening narrowed exposure; writable-script execution and token scope remain

PR #9535 (commit `f685f96863`) landed both checkout flags, the trusted-author gate, and a narrower
Node command pattern. That is measurable hardening, not a complete arbitrary-execution boundary:
the same preset can write repository files and execute `node scripts/*`.

|                                 |                                                                                                                                                                                                                                                                                      |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Landed: primary checkout**    | The primary `actions/checkout` step in `.github/workflows/claude.yml` sets `persist-credentials: false` on the checkout that receives `env.GH_TOKEN`.                                                                                                                                |
| **Landed: automation checkout** | The `.trusted-actions` checkout also sets `persist-credentials: false`; its prompt and tool-map inputs need no git credential.                                                                                                                                                       |
| **Landed: trusted-author gate** | Mention-driven runs remain available for maintainer replies, while the job condition requires trusted author association for the triggering author and the issue or PR author before issue title/body can reach the action.                                                          |
| **Landed: narrowed Node tools** | The `claude-interactive` preset in `.github/automation/allowed-tools.json` no longer grants unrestricted `Bash(node *)`; it permits `Bash(node scripts/*)` plus named npm/pnpm commands.                                                                                             |
| **External scope caveat**       | `BOT_PAT` scope is still inferred rather than verified. Confirm whether it is present, fine-grained, and repository-scoped. If the workflow falls back to `GITHUB_TOKEN`, document that narrower repository/job scope instead of attributing multi-repository reach to the fallback. |
| **Remaining code action**       | Do not combine writable repository files with executable `scripts/*` under credentials. Execute only immutable trusted tooling (for example from `.trusted-actions`) or run mutable-script execution in a credential-free sandbox.                                                   |
| **External verification**       | Verify `BOT_PAT` scope and document the narrower `GITHUB_TOKEN` fallback.                                                                                                                                                                                                            |

### B5 — An outside contributor holds copyright in a substantial merged commit, with no CLA or DCO

|                                                  |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Evidence**                                     | `f7528670de9162d4e534aafa2d5135c47e865368`, `SXKDZ <Mr.SXKDZ@Gmail.com>`, "feat(desktop): modernize the Electron workspace UI (#9216)" — `packages/desktop/src/desktopTaskShell.ts` +491 (now `packages/desktop/src/shared/desktopTaskShell.ts`), `desktopWorkspaceMessages.ts` +263 (now `packages/desktop/src/shared/desktopWorkspaceMessages.ts`), `main/desktopBrowserViews.ts` +238, `main/desktopAgentExecution.ts` +648, `scripts/dev.mjs` +187, plus `electron-builder.yml` and `.github/workflows/ci.yml`. Not de minimis. |
| **No inbound grant**                             | Full listing of `.github/`: `FUNDING.yml`, `PULL_REQUEST_TEMPLATE.md`, `automation/`, `dependabot.yml`, `labels.yml`, `prompts/`, `workflows/`. No CODEOWNERS, no CLA, no DCO. No `CONTRIBUTING.md` anywhere in the tree. GitHub ToS D.6 pins the inbound grant to the outbound notice in the repo at merge time — which was `packages/*/LICENSE.txt:1-3` "All rights reserved", an end-user grant, **not** a sublicensable grant to the repo owner. D.6 does not supply relicensing rights here.                                   |
| **Why I rate this blocker (verifier said high)** | Publishing `packages/desktop` under a new OSS license distributes SXKDZ's copyrighted work under terms he has never granted. That is the same class of exposure as B2/B3 — a license violation against a named third party — not merely an incomplete release. It is also **the only item on this list that becomes strictly harder after the flip**, since publication multiplies the number of holders.                                                                                                                           |
| **Fix**                                          | A one-line email agreement from `Mr.SXKDZ@Gmail.com` consenting to relicense `f7528670` under the chosen license. Then adopt DCO (`Signed-off-by`, low friction) or CLA (required if you want to preserve the `TERMS_OF_SERVICE.md:62`/`:156` assignment-on-incorporation option) and enforce it in CI from day one. Add `.github/CODEOWNERS` in the same change.                                                                                                                                                                   |
| **Not a concern**                                | `LionSR` (5 commits) is the maintainer's own account and every commit is a `"version"`-line bump across 4-5 `package.json` files — uncopyrightable. 361 commits authored as `Claude <noreply@anthropic.com>` raise an authorship-of-record question worth one sentence in the governance doc, nothing more.                                                                                                                                                                                                                         |
| **Effort**                                       | Days (waiting on a human reply — **start this today**, it is the long pole).                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

---

## 3. The open-core decision

Everything else hangs off this. Two sub-decisions that must be made together: **what license**, and
**does `supabase/` ship**.

### 3.1 What is actually coupled

| Surface                                     | Status                                                                                     | Evidence                                                                                                                                                                                                                        |
| ------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `supabase/functions/relay/`                 | Accounting is not independently enforced server-side; details withheld pending remediation | `supabase/functions/relay/`, `supabase/functions/log-usage/`, and the associated migrations; verify in the private remediation tracker                                                                                          |
| `supabase/functions/_shared/emailPolicy.ts` | Live anti-abuse policy whose implementation must not be reproduced in this public proposal | Object path only; already selected for the private boundary in the backend plan's D1                                                                                                                                            |
| `supabase/migrations/`                      | **Cannot rebuild the schema it references**                                                | `rg '^CREATE TABLE' supabase/migrations/*.sql` → 6 tables. `profiles`, `remote_agents`, `agent_whitelist` never created, yet `20260517100300_rls_initplan_wrap_auth_uid.sql:7-31` `ALTER POLICY` on all three                   |
| `docs/supabase/` (13 files)                 | Unclassified; contains a live ops runbook                                                  | `AUTH_OPERATIONS.md:5,23-27,55` (June 2026 OAuth outage, `before-user-created` hook URL). `supabase/README.md:25-29` bans runbooks from a public repo — but that rule only guards `supabase/`, so these slipped past            |
| `prompts/agents/remote/*.yaml` (21 files)   | Gated behind Ultra in-product, but in the tree                                             | `src/controllers/settingsView/SettingsRemoteAgentPromptController.ts:24-28` vs. full `systemPrompt:` bodies in `simplifier.yaml:19+`, `elevate.yaml` (40 KB); `scripts/sync-remote-agents.mjs:242` calls them "Source of truth" |
| Cross-tree test imports                     | 6 vitest files import Deno source by relative path                                         | Already enumerated verbatim at `docs/proposals/2026-08-01-backend-decoupling-plan.md`; the same plan specifies replacement CI with golden fixtures                                                                              |

**Security-safe conclusion:** current relay accounting is not independently enforced on the
server for every billable request. Do not publish implementation details or treat repository
privacy as a mitigation. Server-side accounting enforcement, with adversarial tests proving that
client behavior cannot suppress or falsify billable usage, **must land before publication**. The
implementation and test vectors belong in the private security remediation tracker until fixed.

### 3.2 The three options

| Option                                                                                                                                                    | What it means                                                                                                                                           | Trade-offs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. Publish everything**                                                                                                                                 | `supabase/`, `docs/supabase/`, `prompts/agents/remote/` all public under one license                                                                    | ✅ Cleanest story, no boundary to maintain, no CI split work. ❌ Publishes live enforcement and operational details before the controls are ready; makes `SettingsRemoteAgentPromptController.ts:24-28` absurd (the extension refuses to show a user a file they can `cat` from their clone). Requires fixing the auth-github audience check and landing server-side accounting enforcement **first**.                                                                                                                                                                                                                                                           |
| **B. Split `supabase/` while retaining `docs/supabase/remote-agents.config.json` beside its public sync consumer**                                        | Public repo = the three hosts + core + `scripts/sync-remote-agents.mjs` and its config; private repo = edge functions, migrations, and operational docs | ✅ Matches the backend split while preserving the sync script's required input. ✅ Keeps unpublished enforcement details out of the launch tree. ❌ Requires deleting the `ci.yml:123-128` Deno step and porting 6 vitest files. ❌ Server-side accounting enforcement and the auth-github audience check still gate publication — privacy is not a fix.                                                                                                                                                                                                                                                                                                         |
| **C. Publish everything under a license that matches the business model** (e.g. BSL/PolyForm with a converting date, or AGPL with a commercial exception) | Source-available rather than OSI-open                                                                                                                   | ✅ Lets `supabase/` stay in-tree without inviting a competing relay. ❌ Requires **fresh consent from SXKDZ specifically for that license** (B5), which is a harder ask than MIT/Apache. ❌ Contradicts `docs/guide/open-source.md:242` ("All of these projects are MIT-licensed") on a page linked from the footer of every texra.ai page (`docs/.vitepress/config.js:184`). ❌ Kills the academic-adoption story — a BSL tool is one a university legal office will bounce. ❌ Provenance debt (B2/B3) is _worse_ under a restrictive license, since you would be sublicensing stripped MIT code under terms MIT does not permit you to impose without notice. |

### 3.3 Recommendation

**Option B, with Apache-2.0 on the public repo.**

- **B over A** because live enforcement and operational details should not be published before
  they are remediated. Privacy is only disclosure containment: server-side accounting enforcement
  remains a pre-publication gate and must be verified adversarially in the private remediation
  tracker.
- **B over C** because C's cost lands squarely on B5 — you would be asking a contributor to
  consent to a source-available license, which is materially harder than consenting to a standard
  one, and you would be doing it under time pressure.
- **Apache-2.0 over MIT** for two concrete reasons here: it has an explicit patent grant (relevant
  for an academic tool that may attract institutional adoption), and its §4(b)/§4(d) notice
  machinery gives you a natural home for the B2/B3/Font-Awesome attributions you now have to ship
  anyway. Both are compatible with the inbound MIT you are consuming. If simplicity wins, MIT is
  fine — but pick one and fix all nine declaration sites in a single commit (see §4.1).
- **`prompts/agents/remote/` stays public** and the Ultra gate at
  `SettingsRemoteAgentPromptController.ts:24-28` gets deleted. `2026-08-01-backend-decoupling-plan.md`
  (D2) already leans this way; shipping a paywall on a file that is in the user's own clone is the
  kind of contradiction people screenshot. Note the files are in 5,377 commits of history, so
  "move them private later" is not available without another rewrite.
- **Split `TERMS_OF_SERVICE.md`.** `:29-30` forbid modification and redistribution and `:62`
  asserts proprietary ownership. Scope those to the hosted Service (relay, accounts, quotas) and
  explicitly carve out the repo's code as governed by the new license, or users sit under two
  contradictory grants simultaneously.

---

## 4. High priority — fix before launch

### 4.1 License declarations (one commit, once the decision lands)

Nine sites, no two of which agree today. `docs/proposals/2026-07-29-open-source-readiness.md`
has six of them accurately; the two it misses are:

- **`docs/package.json:22` `"license": "MIT"`** — the only declaration in the tree that _grants_
  rather than reserves, on a package with no `"private": true`. Scope-limiter worth recording:
  `docs/` is outside the workspace (`pnpm-workspace.yaml` globs `packages/*` only), is never
  published to npm, and GitHub's license detection reads the repo-root `LICENSE` — so this is a
  contradiction in a tracked file, not an effective grant. Still fix it; the licensing sweep will
  otherwise complete around it.
- **Copyright-line disagreement**: `README.md:148` "© TeXRA Team 2025–2026" vs.
  `docs/.vitepress/config.js:185` "Copyright © 2024-2026 TeXRA Team", for a holder that
  `TERMS_OF_SERVICE.md:13` defines as "not a corporate entity". A third string exists upstream:
  `texra-ai/texra-scientific-skills`'s LICENSE says "Copyright (c) 2026 texra-ai".

Also set `license` on `packages/desktop/package.json` and `packages/trace-viewer/package.json`
(neither has one; both ship inside the installer despite `private: true`).

### 4.2 Backend security defects (fix regardless of where `supabase/` lives)

| Item                                                                                         | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Severity                 |
| -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| **`auth-github /exchange` accepts any GitHub access token with no OAuth-app audience check** | `supabase/functions/auth-github/index.ts:110-183` — `validateGitHubToken` calls `api.github.com/user` (`:129`) and `/user/emails` (`:161`) and reads neither `X-OAuth-Client-Id` nor `X-OAuth-Scopes`. Repo-wide grep for those headers across `supabase/`, `src/`, `packages/` → **zero hits**. Route `:189-201` accepts only `{github_token}`; success reaches `mintGoTrueSession` at `:357` and returns a refreshable session at `:370`. Sign-up policy checks (`checkEmailDomain` `:295`, `checkGitHubAccountAge` `:304`) sit only in the **new-user** branch — for an existing TeXRA user a bare third-party token walks from `:214` to `:357` with no gate at all. No nonce, no PKCE, no per-route rate limit. Explicitly in scope per `SECURITY.md:32-33`.                                                                              | High                     |
| **Relay accounting lacks independent server-side enforcement** (details withheld; see §3.1)  | Private remediation tracker must map the relay, accounting endpoint, and migration objects                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | High — gates publication |
| **LLM picks its own privilege level for spawned agent CLIs**                                 | `src/tools/codex.ts:121` puts `sandbox_mode` (incl. `'danger-full-access'`, `agentCliSettings.ts:23-27`) in the **model-facing** schema; `codex.ts:552-555` only fills a default when the model _omitted_ it, then passes it through at `:513`→`:521`. Same shape at `claudeAgent.ts:116-118` / `:555-556` / `:243-245` (`bypassPermissions` → `allowDangerouslySkipPermissions = true`). The only gate is `bashApproval.ts:83-88`, which returns `{action:'approve'}` unconditionally when the stream is bypassed — and the bypass is **stream-scoped, not command-scoped** (`bashApproval.ts:42-43` via `sessionBypassAccessors.ts`), so a "don't ask again" on a benign `latexmk` silently pre-approves a later `danger-full-access` launch in the same stream. Squarely `SECURITY.md:31-37` ("Prompt injection that escalates privilege"). | High                     |

For the third: the escalation is **not** invisible (`codex.ts:558` and `claudeAgent.ts:562`
interpolate the mode into the approval label) and **not** undocumented
(`docs/guide/agent-integrations.md:64` states the override exists). The defect is the missing
_ceiling_: treat `getCodexSandboxMode()` / `getClaudeAgentPermissionMode()` as a maximum and
reject or loudly downgrade anything above it — or remove the fields from the model-facing schemas
entirely, since the model has no basis for choosing them.

### 4.3 Contributor-breaking build failures

- **Windows cannot build the extension or the docs at all.** `packages/extension/package.json:1813`
  `"vite:webviews": "… && for v in progressView settingsView webview; do VITE_WEBVIEW=$v vite build; done"`,
  `:1814`, `:1815` (`concurrently "VITE_WEBVIEW=… vite build --watch"`), `:1804`
  (`[ "$SKIP_VSCE_PREPUBLISH" = "1" ] || …`), `:1820` (`mkdir -p …`); `docs/package.json:6-7`
  (`cp ../TERMS_OF_SERVICE.md terms.md`). All POSIX-only; pnpm spawns through `cmd.exe` on
  Windows. No `.npmrc`, no `pnpm.scriptShell`, no `.devcontainer/`, and zero occurrences of
  `windows|wsl|cmd.exe|powershell` in `README.md`, `AGENTS.md`, `CLAUDE.md`, or `docs/dev/*.md`.
  The F5 path is affected: `.vscode/launch.json:16` → `.vscode/tasks.json:7` (`isDefault: true`)
  → `watch:fast` → `vite:webviews:watch`. Root `package.json` scripts are Node-based and portable,
  so the breakage is localized. **Fix**: move the loops/copies into `scripts/*.mjs` Node helpers,
  or state Windows-unsupported-for-dev + recommend WSL in one line. Silent `cmd.exe` syntax errors
  are the worst of both. _(The maintainer's §4.6 covers Windows **test** failures and never
  notices the build is unrunnable there.)_
- **Every Windows checkout fails `format:check` and is blocked by pre-commit.** `.gitattributes`
  is one line — `.github/workflows/*.lock.yml linguist-generated=true merge=ours` — and
  `ls .github/workflows` shows 13 plain `.yml` files, so the rule is dead. `.prettierrc` has no
  `endOfLine`; no `.editorconfig` exists; `git ls-files --eol` → `3101 i/lf`. Gates:
  `.github/workflows/ci.yml:110` and `.pre-commit-config.yaml:4-8`. **Fix**: add
  `* text=auto eol=lf`, drop the dead rule. _(The "unmergeable 3,100-file diff" is refuted —
  git's clean filter re-normalizes under `core.autocrlf=true`. The damage is red CI plus a
  pre-commit hook that refuses every commit until the contributor discovers `core.autocrlf=false`.)_

### 4.4 Repo identity — the sweep that will report complete while still broken

`docs/proposals/2026-07-29-open-source-readiness.md` (§3.1) enumerates manifests, README,
guide docs, `config.js`, and `.github/labels.yml`. It was built from a ripgrep sweep, and
**ripgrep skips dotfiles by default** — so `.github/**` (9 hits) and `.claude/**` are absent from
its list. Re-run with `rg --hidden`. Uncovered instances:

| Site                                                                                                                                 | What breaks                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.claude/skills/tech-debt-tournament/SKILL.md:14`, `:21`, `:25`                                                                      | Ships "Ledger issue: **LionSR/TeXRA#8974**" and `query: "repo:LionSR/TeXRA is:issue label:tech-debt"` — a user-invocable skill that searches a repo outsiders cannot read. Either parameterise from runtime context (as `.github/prompts/repository-quality-improver-prompt.md` already does) or move it out of the published tree; it is maintainer process, unlike `code-review`/`texra-cli`/`releasing` |
| `.claude/skills/code-review/references/review-checklist.md:125,128,139`                                                              | Makes "a dated #6981 row" a **merge blocker** and cites "the #7210 pattern" — normative gates pointing at issues an outsider cannot open, in the skill `CLAUDE.md` tells every contributor to load                                                                                                                                                                                                         |
| `src/test-kernel/agent/followUp/ToolUseDispatchInterruption.vitest.ts:149`, `src/test-kernel/tools/GitHubPrTypes.vitest.ts:24,40,62` | `LionSR/TeXRA` fixtures                                                                                                                                                                                                                                                                                                                                                                                    |
| `docs/supabase/REMOTE_AGENTS_IMPLEMENTATION.md:184`, `MIGRATION_UNIFY_MULTIPLE.md:48`, `SUPABASE_SETUP.md:196,729-730`               | Stale `LionSR` publisher identity, contradicted by `packages/extension/package.json:6` `"publisher": "texra-ai"` and `src/auth/config.ts:241`                                                                                                                                                                                                                                                              |

### 4.5 Stale docs that publish for the first time on flip day

`docs/supabase/` is excluded from texra.ai (`docs/.vitepress/publicDocs.js:45` — `'supabase/**'`
in `srcExclude`) and is **not counted** by the readiness audit: `:120-122` states "145 files
across `docs/prds/` (77), `docs/proposals/` (68), …" and 77 + 68 = 145 exactly, so the four
trailing directories contribute nothing and `docs/supabase/` (13), `docs/pocketflow/` (1),
`docs/skills/` (1) are never named. Fifteen unlisted files publish by default. Concretely wrong:

- `REMOTE_AGENTS_IMPLEMENTATION.md:103-107` tells self-hosters to set three VS Code settings
  (`TeXRA: Auth › Supabase Url`, `Auth › Supabase Anon Key`, `Remote Agents › Edge Function Url`).
  All 52 keys across the 18 `contributes.configuration` sections in
  `packages/extension/package.json` were enumerated; filtered on `/auth|relay|url|supabase|remote/i`
  → **zero matches**. All three settings are fiction.
- `RELAY_SETUP.md:9-11` states $3/M tier boundaries; `supabase/functions/relay/models.ts:130-131`
  says 1.5 / 9.
- `MIGRATION_PREMIUM_TO_RESEARCHER.sql:21` `CHECK (tier IN ('free','researcher'))` vs.
  `src/auth/config.ts:119` `z.enum(['free','Max','Ultra'])`.
- `AUTH_OPERATIONS.md` is an incident runbook — the exact artifact `supabase/README.md:25-29`
  forbids in a public repo. The rule only guards `supabase/`, so it slipped past.

**Fix**: delete or rewrite these four files; move `AUTH_OPERATIONS.md` and the operational SQL to
the private repo. Note `scripts/sync-remote-agents.mjs:21,242` writes
`docs/supabase/SYNC_REMOTE_AGENTS.sql`, so it moves with them or gets repointed.

_(Do **not** add env-var backend-override plumbing on the strength of these docs — see §6.)_

### 4.6 The `docs/proposals` split will break CI, and the readiness audit does not say so

`scripts/check-guidance-refs.mjs:26-27` (`GUIDANCE_FILES = ['CLAUDE.md','AGENTS.md']`,
`GUIDANCE_DIRS = ['.claude/skills','docs/dev']`) plus `:61-73` (`PATH_PREFIXES` includes `'docs/'`)
fails any unresolvable cited path, and it runs as the **deliberately ungated** `guidance-refs` job
(`.github/workflows/ci.yml:142-166`). Load-bearing citations that break on a split:

- `CLAUDE.md:90`, `.claude/skills/code-review/SKILL.md:20`, `review-checklist.md:134` →
  `docs/proposals/2026-06-10-error-pipeline-and-ownership.md`
- `review-checklist.md:123` → `docs/proposals/2026-07-07-fewer-elements.md` (source of the R1/R5–R8
  rules the PR template enforces)
- `review-checklist.md:113` → `docs/proposals/2026-07-03-tech-debt-audit.md`
- `.claude/skills/texra-cli/SKILL.md:115` → `docs/proposals/2026-07-03-ink-practices-from-claude-code.md`
- `CLAUDE.md:149`, `AGENTS.md:471` → `docs/architecture/pocketflow-state.md`

**Fix**: inline the load-bearing content into `AGENTS.md` / the review checklist first, so the
rules stand alone; then let the proposals become non-normative history. Run
`scripts/check-guidance-refs.mjs` as the acceptance test for whichever split you choose.

---

## 5. Medium / post-launch

### Legal & attribution (one file closes most of it)

Generate `THIRD-PARTY-LICENSES.txt` at build time (`pnpm licenses list --json` or
`license-checker-rseidelsohn`) and add it to `REQUIRED_PACKAGED_PATHS` in
`scripts/verify-extension-package-invariants.mjs:41-58` and to `files`/`extraResources` in
`packages/desktop/electron-builder.yml:29-51`. Bundlers are not a mitigation:
`packages/extension/esbuild.config.mjs:42` sets `minify: production`,
`packages/extension/vite.config.ts:34` sets `minify: 'esbuild'`, neither sets `legalComments`, and
the built 9,762,585-byte `dist/extension.js` contains **12** `@license`/`Copyright (c)`
occurrences total. Fold in:

- **B2 (PocketFlow)** and **B3 (gemini)**.
- **Font Awesome Free**, `(CC-BY-4.0 AND MIT)` per
  `node_modules/.pnpm/@fortawesome+free-solid-svg-icons@7.3.1/…/package.json:31`. CC BY 4.0
  attribution is mandatory and is **not** satisfied by your own LICENSE. The artwork is re-emitted,
  not linked: `src/shared/wa/webAwesomeIcons.ts` imports 125 icons (`:2-126`), `iconSvg()`
  (`:143-151`) rebuilds `<path d="…"/>` from `svgPathData`, `:310` wraps it as a `data:` URI and
  `:313-322` registers it for both the TeXRA and WA `default` libraries — so it renders in all four
  hosts. Upstream ships a `LICENSE.txt` that reaches no TeXRA artifact.
  `docs/proposals/2026-07-29-open-source-readiness.md` classifies the tail as "remainder
  permissive" and never names CC-BY-4.0. An in-app credit in settings/about is the cleaner fix.
- **`patches/openai@6.46.0.patch`** — Apache-2.0 NOTICE propagation. (The §4(b) "modified files"
  concern is largely satisfied already: a version-named patch file in `patches/` is a more legible
  change record than a header comment. The current `patches/ink@7.1.1.patch` is MIT, same
  treatment. The earlier audit snapshot's 7.1.0 filename was superseded when the resolved Ink
  version changed.)
- **`skills/`** — `ls -a skills/` returns exactly the 14 directories that
  `docs/guide/open-source.md:145-153,171-177` enumerate as the contents of
  `texra-ai/texra-scientific-skills` and `texra-ai/texra-lean-skills`, with **no** LICENSE, README,
  or provenance file at any level. The public counterparts are MIT
  (`raw.githubusercontent.com/texra-ai/texra-scientific-skills/main/LICENSE` → "Copyright (c) 2026
  texra-ai"), so identical content is offered under two different licenses simultaneously — and
  it is redistributed under this repo's terms via `scripts/copy-extension-skills.mjs:11,17` →
  `verify-extension-package-invariants.mjs:53` and `electron-builder.yml:48-51`. Put a LICENSE in
  `skills/` and record which copy is canonical.

The limited registry sweep found **no GPL/LGPL/AGPL/SSPL/BUSL/Commons Clause declarations** in
the 735 packages at npm's current `latest` dist-tags; it also observed file-level MPL-2.0 in
lightningcss and a dual MPL/Apache declaration in dompurify. This is **not** a release clearance:
before launch, scan the exact npm versions in `pnpm-lock.yaml`, review the complete Deno/JSR graph,
resolve dual/file-level terms against shipped artifacts, and add a CI gate for disallowed license
classes.

### CI / release

| Item                                                                                             | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Note                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **npm provenance is disabled with a comment that expires on the flip**                           | `.github/workflows/release.yml:143-151` — "this repo is private, so … provenance generation must be disabled or npm rejects the publish with a 422" + `NPM_CONFIG_PROVENANCE: 'false'`. Duplicate at `:196-200` in the `publish-agent` job, itself dead-gated at `:157` (`if: ${{ false && … }}`). `id-token: write` is already present (`:161-163`) and `npm@^11.5.1` is already installed (`:138-139`).                                                                                                                                    | **Ordering matters**: `packages/cli/package.json:10` `repository.url` is `git+https://github.com/texra-ai/texra-issues.git`, not the build repo. Fix repository fields in §4.4 **first**, then delete the env block — otherwise you trade a 422 for a repository-mismatch failure. Failure mode is silent: the publish keeps succeeding, unattested, forever.                                  |
| **The docs boundary gate never runs for a mixed code+docs PR**                                   | `docs/scripts/check-root-docs.mjs:1-9` calls itself a CI gate. Its only CI path is `npm run docs:build` (`docs/package.json:11` → `:9`) at `ci.yml:401`, inside `docs-check` (`ci.yml:363`) whose condition at `:370` is `needs.changes.outputs.code != 'true'`; `ci.yml:59-60` sets `code=true` for any changed file outside `docs/` that is not `*.md`. Post-merge backstop is `docs-deploy.yml:42-44`, so the stray doc merges and the next push to main fails Deploy Docs against the dist-root allowlist (`:59-90`), freezing texra.ai. | Fix: add `node docs/scripts/check-root-docs.mjs` to the already-ungated `guidance-refs` job (`ci.yml:142-166`), and correct the script header. One line.                                                                                                                                                                                                                                       |
| **8 of 9 edge functions, incl. the entire auth surface, sit outside every gate**                 | `ci.yml:122-128` is the repo's only Deno step, `working-directory: supabase/functions/relay`. `find supabase -name 'deno.json*'` → 8 configs, 7 unchecked; `_shared/` (9 modules incl. `auth.ts`, `crypto.ts`, `goTrueSession.ts`, `relayCiToken.ts`) has no `deno.json` at all. Three committed test files never execute: `auth-device/approvalRequest_test.ts`, `before-user-created/webhookVerification_test.ts`, `log-usage/usageValidation_test.ts`.                                                                                    | Only relevant if `supabase/` stays public. If it moves private, this becomes the private repo's problem — but it is still a real hole on the surface `SECURITY.md:32,39` puts in scope.                                                                                                                                                                                                        |
| **PR CI never builds desktop bundles or the CLI production bundle**                              | `ci.yml:206-282` runs only `validate:tui`, `pnpm --filter texra build:fast`, `check:vsix-contents`; `runtime-validation` is `if: github.event_name != 'pull_request'` (`:322-323`); `desktop-package.yml:2-3` is `workflow_dispatch:` only. `validate:tui` builds a _separate_ 50-line entry (`packages/cli/scripts/build-harness.mjs`) — `packages/cli/scripts/build-bundle.mjs` (100 lines) is never exercised on a PR, and neither is `check:architecture`.                                                                               | `ci.yml:261-263` intentionally excludes desktop _packaging_; `desktop:build` (esbuild + Vite) is a different, cheap thing not covered by that rationale.                                                                                                                                                                                                                                       |
| **`check:remote-agents` is a drift gate nothing invokes**                                        | `package.json:58`. Every sibling has a caller (`check:dead-code-ratchet` → `ci.yml:131`, `check:tsconfig-paths` → `:140`, `check:vsix-contents` → `:264` and `release.yml:77`, the five desktop ones → `desktop-package.yml`). This is the only unwired one.                                                                                                                                                                                                                                                                                 | One line next to `ci.yml:140`.                                                                                                                                                                                                                                                                                                                                                                 |
| **Both AI review workflows silently no-op on fork PRs and report green**                         | `claude-code-review.yml:102-107` writes `skip=true` + a `reason` output; every later step is gated on `skip != 'true'` (`:110,116,124,132,156,175`) **including the failure gate at `:172-182`**, so the job reports success having done nothing. `rg 'provider-token.outputs'` confirms `reason` is written once and read **zero** times. Contrast `texra-code-review.yml:63`, which emits `::notice::`.                                                                                                                                    | This is the automation equivalent of `catch {}` — the defect class `CLAUDE.md` names. Post a comment or mark the check neutral.                                                                                                                                                                                                                                                                |
| **`.trusted-actions` protects the prompt but the prompt reads PR-controlled guidance**           | `claude-code-review.yml:109-113` checks out the PR (no `ref:`) while `:115-121` puts only the base ref in `.trusted-actions`; the trusted prompt `.github/prompts/claude-code-review-prompt.md:5-7` then says "Read `.claude/skills/code-review/SKILL.md`", "Consult `CLAUDE.md` and `AGENTS.md`" — all resolving into the untrusted checkout.                                                                                                                                                                                               | Bounded: fork PRs skip entirely (no secrets). Applies to same-repo branches, and widens when the repo moves to `texra-ai` and `MEMBER` covers more people. `docs/dev/verification.md:53-61` is **correctly** scoped and needs no correction. Fix: sparse-checkout the guidance into `.trusted-actions` too, or skip automated review when the diff touches `.claude/`/`CLAUDE.md`/`AGENTS.md`. |
| **Signing secrets are job-scoped, so `pnpm install` sees them**                                  | `desktop-package.yml:37-46` (CSC_LINK, CSC_KEY_PASSWORD, APPLE_*) at job scope with `pnpm install --frozen-lockfile` at `:65`; Windows equivalent `:190-197`/`:216`. Consumed only at `:103` / `:234`. The workflow's own `unset` at `:91-102` shows the narrowing is understood — it just happens too late.                                                                                                                                                                                                                                 | Mitigated by `workflow_dispatch:`-only triggering (`:3-25`) and pnpm's deny-by-default `allowBuilds:` (`pnpm-workspace.yaml:12-21`, 9 named packages). Move the `env:` blocks down one level; add `permissions:` to the three installer jobs (`:32`, `:128`, `:185`).                                                                                                                          |
| **Dependabot covers only the root workspace**                                                    | `.github/dependabot.yml:3-4` — one entry, `npm` / `/`. No `github-actions` ecosystem, so even the one SHA-pinned action (`texra-code-review.yml:112`) never gets bumped. `docs/` is outside the workspace (`pnpm-workspace.yaml:1-2`) yet `docs/package-lock.json` (139 KB, `vitepress ^2.0.0-alpha.15`) builds and force-pushes the public site (`docs-deploy.yml:40,120-122`) with zero monitoring.                                                                                                                                        | Add `github-actions` + a second `npm` entry at `/docs` (needs `--legacy-peer-deps` handling per `docs-deploy.yml:37-39`). Deno has no Dependabot ecosystem — not a gap.                                                                                                                                                                                                                        |
| **SHA-pin the one action that holds publish credentials**                                        | `release.yml:88` and `:96` — `HaaLeo/publish-vscode-extension@v2` receiving `VSCE_PAT` and `OVSX_PAT` in the same job. This is the only genuinely third-party action holding high-value secrets.                                                                                                                                                                                                                                                                                                                                             | Unchanged by repo visibility. Pin both to SHAs in the style of `texra-code-review.yml:112`.                                                                                                                                                                                                                                                                                                    |
| **Version-bump PRs are opened with `GITHUB_TOKEN`, so they trigger no CI**                       | `version-bump.yml:57-59`, while `:49`/`:52-54` rewrite every manifest and regenerate `pnpm-lock.yaml`. `ci.yml:403-462` (`validate-status`) is clearly designed as the required check.                                                                                                                                                                                                                                                                                                                                                       | Decide before enabling required status checks, not after. `claude.yml:133` already passes `BOT_PAT` to a sibling auto-PR action.                                                                                                                                                                                                                                                               |
| **No `permissions:` at all in `ci.yml`; three installer jobs in `desktop-package.yml` likewise** | `rg '^\s*permissions:' .github/workflows/` hits 11 files; `ci.yml` (461 lines, 9 jobs) has none, and `desktop-package.yml`'s only block is `:275`.                                                                                                                                                                                                                                                                                                                                                                                           | Blast radius only — fork runs are read-only regardless. Add `contents: read` + set the repo default to read-only.                                                                                                                                                                                                                                                                              |
| **No workflow guards on `github.repository ==`**                                                 | `docs-deploy.yml:3-8` fires on push to main; `:106` writes `CNAME texra.ai`; `:113-121` force-pushes gh-pages. Same gap in `label-sync.yml`, `version-bump.yml`.                                                                                                                                                                                                                                                                                                                                                                             | Nearly unreachable — GitHub disables _all_ workflows in forks until the owner opts in (platform behavior, not in-repo). Two-line fix, low priority.                                                                                                                                                                                                                                            |

### Code hygiene

- **2,168 lines of desktop Playwright specs are outside typecheck, lint, `npm test`, and every
  workflow — and are already rotting.** Exclusions: `vitest.config.mjs:26`; all four
  `packages/desktop/tsconfig*.json` `include` only `src/` + `vite.config.ts`; root
  `package.json:9` lints `packages/desktop/src` only; the sole Playwright reference in CI is
  `desktop-package.yml:154` (`install-deps chromium`, feeding the packaging smoke at `:163-165`).
  Compiling them proves the rot has landed: `packages/desktop/tests/e2e/menuLifetime.spec.ts:49`
  → `TS2367` — `item.role === 'appmenu'` compares against a literal Electron's union does not
  contain, so that lookup is statically dead. Baselines are never diffed:
  `screenshots.spec.ts:21-27` returns `testInfo.outputPath()` unless
  `TEXRA_UPDATE_E2E_SCREENSHOTS === '1'`, and `rg 'toHaveScreenshot|toMatchSnapshot'
packages/desktop/tests/` → zero. `knip.json:36` lists `tests/**` as an entry but `project` is
  `src/**`, so knip does not parse them either.
- **`packages/agent` is a never-shipped SDK advertised in the release pipeline.**
  `release.yml:153-158`: `publish-agent`, comment "NOT PUBLISHED YET: @texra-ai/agent has no npm
  package or trusted publisher configured", `if: ${{ false && … }}` — and 60 lines of dead steps
  through `:201`. The package is 510 source lines (`src/index.ts` 301, `node.ts` 160,
  `schemas.ts` 49) against **70** runtime dependencies, `private` unset,
  `publishConfig.access: 'public'`, version-bumped every release, `registry.npmjs.org` → 404, no
  README. PR #9537 archived the checkpoint series: there are **zero**
  `*agent-sdk-readiness-checkpoint.md` files under `docs/proposals/`, and all **21** live under
  `docs/dev/audits/`. Five core agent-SDK planning documents remain among the 54 proposal Markdown
  files. Pick: ship the package, mark `"private": true` and delete the dead job, or add a README
  saying it is pre-release. Consolidating or indexing the 21 archived checkpoints is optional
  follow-up; relocation is complete.
- **ESLint disables the two rules everyone looks for, under "REVISIT LATER".**
  `eslint.config.mjs:501-502` (`no-explicit-any: 'off'`), `:504-510`, `:525-526`
  (`no-unused-vars: 'off'`). Measured debt is tiny — exactly 20 `any` occurrences in non-test
  production source across 17 files, zero `eslint-disable` escapes. The config understates the
  codebase's real discipline and will be the first quotable line in a skeptical thread. Turn both
  on (`varsIgnorePattern: '^_'`), fix ~40 sites, delete the comments.
- **`supabase/migrations/` cannot build the schema it references.** `rg '^CREATE TABLE'
supabase/migrations/*.sql` → 6 tables; `profiles`, `remote_agents`, `agent_whitelist` never
  created, yet `20260517100300_rls_initplan_wrap_auth_uid.sql:7-31` `ALTER POLICY` five policies
  across all three, and `20260602120000_lock_down_profiles_privileged_columns.sql` revokes/grants
  on `profiles`. The **auditability** cost is the real one: `profiles.tier` is what the relay
  trusts (`relay/index.ts:494`), gating both `:500-507` and `:510`, and the RLS UPDATE policy that
  stops a user self-promoting is precisely what is missing — while `20260602120000`'s header
  documents that exactly that bug once shipped. (The "contributors can't `supabase db reset`"
  argument is weak: `supabase/README.md:1-6` says this tree is the canonical cloud source pending a
  private infra repo, not a self-hostable backend.)
- **Applied one-off production DDL lives in `docs/` outside the migrations directory.**
  `docs/supabase/MIGRATION_FLEXIBLE_USER_GROUPS.sql:17` (`ALTER TABLE profiles ADD COLUMN … permissions TEXT[]`),
  `:23` (`DROP CONSTRAINT profiles_tier_check`), plus `ADD_*.sql` and
  `MIGRATION_PREMIUM_TO_RESEARCHER.sql`, documented as copy-paste-into-the-SQL-Editor
  (`ADD_LEAN_AGENTS.sql:1-11`). Contrast `SYNC_REMOTE_AGENTS.sql:1-3`, which is generated and
  script-owned (`package.json:57`).
- **`axios@1.17.0`** (single resolved version, sole path `arxiv-client@0.0.9`) carries
  GHSA-mwf2-3pr3-8698, vulnerable `>=1.13.0 <1.18.0`. `pnpm audit --prod` → "2 low | 11 moderate |
  1 high". Not exploitable here (public arXiv metadata), but landing with a clean audit removes
  scanner drive-bys before they start — consistent with `SECURITY.md:52`. Fix: pnpm `overrides`
  pin to `^1.18.0` (Dependabot cannot reach a transitive pinned by an unmaintained direct dep).

### Product surface

- **Nothing states what is free vs. paid.** `src/auth/config.ts:118` defines
  `['free','Max','Ultra']` with `:131-135` `{free:10, Max:50, Ultra:300}` dollar constants, and
  exactly **one** user-facing string in the entire codebase names a plan:
  `src/controllers/settingsView/SettingsRemoteAgentPromptController.ts:27` "Viewing remote agent
  prompts requires an Ultra plan." No docs page mentions Ultra or Max; `TERMS_OF_SERVICE.md` has
  no fees section; there is no payment processor anywhere in the tree.
  `src/controllers/modelAccess/installTexraModelAccess.ts:25-27` even contains a truncated
  sentence — "cost far more per request than the tier prices in," — dangling at pricing that does
  not exist. One paragraph fixes this; it is not a pricing-page project. _(The "undisclosed
  monetization" reading is refuted — see §6 — the dollar figures are TeXRA's own per-tier relay
  cost ceilings, consistent with `docs/guide/remote-agents.md:126` "We do not charge".)_
- **`docs/guide/open-source.md` is footer-linked from every texra.ai page**
  (`docs/.vitepress/config.js:184`, nav at `:174`) and its premise at `:3` — "We've open-sourced
  **key components of our infrastructure**" — becomes false on flip day; the page never lists
  TeXRA. Rewrite it as part of the flip changeset, leading with the repo and its license. It is
  also the natural home for the B2/B3/Font-Awesome credits.
- **No `CITATION.cff`**, on a tool whose audience is academics and whose
  `docs/guide/acknowledgments.md:7` promises "we will provide a preferred citation format" and
  points at `github.com/texra-ai/texra-issues` (no code). The material to cite is already on the
  same page at `:22` (ICML 2026, arXiv:2506.06214). The flip turns on GitHub's "Cite this
  repository" widget; it will be dark.
- **npm namespace is squattable.** `registry.npmjs.org/-/org/texra/package` → `{"error":"Scope not
found"}`; `registry.npmjs.org/texra` → 404 — while `packages/extension/package.json` declares
  `"name": "texra"` with `"private": false` and **no `files` allowlist**. Register `texra` and
  `@texra` defensively **before** publishing the repo, and set `"private": true` on
  `packages/extension` (it ships as a VSIX via `vsce`, never via npm).
- **14/14 shipped skills say "Use when Codex needs to…"** in front-matter (`skills/*/SKILL.md:3`),
  copied verbatim into the extension by `scripts/copy-extension-skills.mjs:20-21` and wired into
  `contributes.chatSkills` at `packages/extension/package.json:1623` — whose host is Copilot Chat.
  One `sed`, done upstream in the MIT satellite repos so the next re-vendor does not undo it.
- **`docs/guide/remote-agents.md:25`** offers "GitHub, Google, or GitLab"; `src/auth/config.ts:92`
  is `['github','google']`. README gets it right; the guide does not.
- **`TERMS_OF_SERVICE.md:74` calls usage logs "anonymized"** when every row carries `user_id`
  (`log-usage/index.ts:129`) and the admin view re-identifies directly
  (`20260609212200_drop_usage_base_view.sql:30-47` joins `profiles.email`). That is _pseudonymous_,
  and the distinction is legally operative under GDPR. The four-field list is also incomplete
  (`log-usage/index.ts:133-146` adds agent_name, stream_id, extension_version, editor_type, …),
  and §9 never states the opt-out's plan-accounting carve-out
  (`src/telemetry/UsageLogService.ts:82-95`). `docs/guide/configuration.md:340-347` states all of
  this correctly — align the legal doc to the guide, not the reverse.
- **`TERMS_OF_SERVICE.md:38`** says "API keys are stored locally using VS Code's built-in Secret
  Storage" — false for the CLI (`packages/cli/src/runtime/cliSecrets.ts:49-51,83`, plaintext JSON
  at `~/.texra/secrets.json`) and the desktop app (`electronSecrets.ts:121-126`, Electron
  safeStorage). _(The storage design itself is fine: `cliSecrets.ts:15` sets `0o600` and
  `jsonStore.ts:54-56,213-220` chmods the containing directory to `0o700` — same posture as `gh`,
  `aws-cli`, `npm`.)_
- **Marketplace Q&A is on by default.** `packages/extension/package.json` declares no `qna` key,
  so the storefront opens a third inbox next to `README.md:143`'s `texra-issues` and the source
  repo's newly-enabled Issues tab. Set it deliberately. `sponsor` is optional polish
  (`README.md:43-44` already carries the links).
- **A BYOK user who never signed in still contacts `remote.texra.ai` on first model call.**
  `ModelHandler.ts:501-506` → `ServerSideKeyService.ts:139-141` (preference defaults `true`
  whenever a globalState store exists) → `:302-310` (anonymous `getConfig(undefined)`) →
  `src/auth/config.ts:86` `RELAY_TIER_CONFIG_URL`. No credential or prompt content leaves; it is an
  unauthenticated GET on the dispatch path. But the opt-out is UI-only, unlike the two existing
  env kill switches (`src/telemetry/UsageLogService.ts:62-65`,
  `src/utils/system/semverUpdateCheck.ts:29`, both via `src/utils/system/envFlags.ts`). Add
  `TEXRA_NO_INCLUDED_ACCESS` using the same helper and document the full set of hosts TeXRA
  contacts. One call to an existing helper; the launch-thread cost of not having it is real.

### Repo presentation

- **254 remote branches**, 152 of them `origin/claude/*`, oldest `origin/backend` at 2024-11-11.
  35 are already merged into `origin/main`, 32 have no commit since 2026-06-01 — that is a
  zero-risk delete list covering a quarter of them. `origin/backend` must go regardless (see B1);
  keep `origin/gh-pages` (live deploy target).
- **Ten author identities on one email.** `git shortlog -sne --all` → `14889516+LionSR@users.noreply.github.com`
  under `Ray` (6,921), `Sirui Lu` (2,566), `Sirui Lu` (2,437), `Sirui Lu` (1,149), `Sirui Lu
(laptop)` (169), `Sirui Lu (MPQ office)` (152), three `(aider)` variants, `Squirrel` (2). No
  `.mailmap`. A root `.mailmap` collapses the contributors graph retroactively with no rewrite —
  but note it does **not** remove the address from commit objects; that is a `filter-repo` decision
  for the B1 window if you want it.
- **`docs/prds/cli-tui-ink/mockups/`** (11 mockups + README) ends each file with open questions
  answered by pasted chat replies: `2026-05-14-08-tool-variants.md` "User: ok, do as you
  recommend. don't overcrowd the TUI"; `2026-05-14-05-transcript-search.md` "User: this can
  wait."; `2026-05-14-01-streaming.md` where four either/or questions each end with a bare
  "User: yes" / "User: maybe both?" — so the record does not say what was chosen. No secrets, no
  PII; this is tone plus doc-usability, and a reason to lean toward the "split to a private repo"
  arm §2.3 already offers.
- **Two undated, current-tense design docs describe code that no longer exists.**
  At audit time, `docs/pocketflow/state_architecture.md:35-40` showed `runState.toSnapshot()` /
  `AgentRunState.fromSnapshot(...)`; the corrected current document is
  `docs/architecture/pocketflow-state.md` — there is no `AgentRunState` class at all (`rg 'AgentRunState'
src/` yields only `AgentRunStateSnapshotSchema`/`AgentRunStateSnapshot` at
  `src/agent/core/state/AgentState.ts:22-29`; the methods live in `AgentWorkspaceState.ts:437,470-472`).
  Both guidance files now route contributors to the corrected document.
  `docs/design/2026-06-20-subagent-output-design.md:5` asserts "`executeAgent()` returns `void`" against
  `src/agent/runtime/executeAgent.ts:409-430` (`Promise<AgentRuntimeFlowResult>`, two overloads),
  and its call graph at `:9`/`:246` names `executeAgentWithLogging`, a symbol whose only occurrence
  in the repo is that doc. Neither file is inside `scripts/check-guidance-refs.mjs`'s
  `GUIDANCE_DIRS` (`:26-27`) — add `docs/architecture` and `docs/design`.
- **`docs/dev/verification.md:19-21`** tells contributors that `npm run typecheck` has pre-existing
  `@openrouter/sdk/models` errors to ignore. It does not: that resolution is aliased in all three
  tsconfigs (`tsconfig.json:50-56`, `packages/extension/tsconfig.json:49-55`,
  `packages/desktop/tsconfig.paths.json`) and `typecheck:workspace` runs clean. Delete the two
  comment lines — this is the one file whose job is to teach verification, and it trains people to
  shrug off type errors.
- **`docs/dev/texra-cli-checkout.md:4-6`** says "the repository is not open source" and `:30` cites
  a `"Local CLI (texra-local)"` section of `CLAUDE.md` that does not exist (`rg -ni
'texra-local|local cli' CLAUDE.md` → zero).
- **`.vscode/settings.json:15`** commits `"texra.ui.showLoginBanner": false` — the only
  unjustified entry in an otherwise build-only, fully-commented file. Sharper:
  `grep -c 'showLoginBanner' packages/extension/package.json` → **0**, so the key is undeclared in
  `contributes.configuration` even though `src/controllers/mainView/MainViewStartupController.ts:82-87`
  reads it and `:104-107` uses it. Every contributor sees an "Unknown Configuration Setting"
  warning on an uncommented line that suppresses the sign-in banner — the exact onboarding surface
  they need to test. Introduced in `03db4189d` as a testing leftover. Delete the line.
- **`docs/guide/configuration.md:147`** ships `C:\\Users\\thinking\\scoop\\...` where the same file
  uses `C:\\Users\\Username\\` at `:436` and `/Users/username/` at `:444`. Published live
  (`docs/.vitepress/publicDocs.js:29`). One word.
- **`docs/reference/`** is two files: `relay-tier-config.md` and an orphaned `index.md` whose `:3`
  is site-voiced ("For step-by-step guides, see the [Guide](/guide/) section") and whose every link
  redirects back into `/guide/`, in a directory `publicDocs.js:41` excludes from the site and
  `config.js` never references. Delete `index.md`.
- **`QITBench`** appears in exactly two files repo-wide (`docs/supabase/SYNC_REMOTE_AGENTS.sql:33,48`
  and `docs/supabase/remote-agents.config.json:18,21`) as an undocumented `visibility` tier
  alongside `whitelist`/`researcher`/`public`. `2026-08-01-backend-decoupling-plan.md` places
  `remote-agents.config.json` in the "Stays public" table, so this is a decided publication —
  decide whether to document the tier or rename it to a generic key.
- **Prerequisites nobody documented**: Deno 2.8.3 (`ci.yml:94-97`, `:123-128`) with zero install
  guidance anywhere (checked `README.md`, `AGENTS.md`, `CLAUDE.md`, `docs/dev/`, `docs/guide/`,
  `supabase/README.md`, `supabase/writing_edge_functions.md`); Linux desktop e2e needs
  `playwright install-deps` + `xvfb-run` (`desktop-package.yml:154,163-165`) which
  `docs/dev/verification.md`'s bare `pnpm exec playwright test` does not mention; and `electron` is
  **absent** from `pnpm-workspace.yaml`'s `allowBuilds:` list, so its postinstall never runs and the
  ~100 MB binary downloads lazily on first `require('electron')` (reproduced: `node
scripts/check-desktop-electron-binary.mjs` prints "Downloading Electron binary…" on a fully
  installed tree). Also: root `package.json` has **no `engines`** while corepack-provisioned
  pnpm 11.5.2 requires `node >=22.13` and `README.md:22,122` +
  `packages/{cli,agent}/package.json` all say `>=22.9.0`. No `.nvmrc`/`.tool-versions`.
- **The PR template demands undefined rule IDs.** `.github/PULL_REQUEST_TEMPLATE.md:17-19` (`## Net
elements (R6)`) and `:21-23` (`## Consumer counts (R8)`). `rg '\bR6\b|\bR8\b' AGENTS.md CLAUDE.md
README.md` → two lines, `AGENTS.md:577-578`, which merely restate that the template requires
  them. The template's inline HTML comments _are_ operative instructions (a contributor can fill
  both correctly without the checklist — see §6), so this is one link, not a rewrite. `README.md`
  contains no pointer to `AGENTS.md`, contributing, or pre-commit (verified by grep).

---

## 6. Explicitly not worth doing

Things a generic audit — or one of the eleven auditors — would tell you to do, that this repo
should skip. Each was checked and refuted.

| Recommendation                                                                                             | Why skip                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **"SHA-pin all `LionSR/agent-ci-actions@v1` call sites; it's a third-party supply-chain root"**            | `git remote -v` → `origin … /git/LionSR/TeXRA`. **`LionSR` is the account that owns this repository.** Six of the eight cited `uses:` are first-party — same trust boundary as the repo itself. One auditor independently confirmed the action repo is **public** (3 stars, created 2026-06-04). Moving it to `texra-ai` + SHA-pinning is reasonable tidiness, not a supply-chain finding.                                                                                                                                                                                                                                               |
| **"Fork PRs will fail on `LionSR/agent-ci-actions`, breaking day-one contributors"**                       | Every call site is unreachable for outsiders: `claude-code-review.yml:135` is behind the provider-token skip (`:85-107`, documented at `:53-55`); `issue-tracker.yml:138` has the identical gate at `:55-77`; `claude.yml:79/:122` require `author_association` in OWNER/MEMBER/COLLABORATOR (`:28-34`); `issue-tree.yml` and `repository-quality-improver.yml` are schedule-only, which GitHub disables in forks.                                                                                                                                                                                                                       |
| **"Rewrite ~980 bare `#NNNN` refs in docs / 442 in source, they'll mislink"**                              | GitHub autolinks `#N` in **issue/PR/commit bodies and markdown rendering**, not in source-blob views — a `// see #3781` in a `.ts` file renders as plain text. The docs are already excluded from texra.ai (`publicDocs.js:35-40`). Also, `rg -nP '#\d{3,5}' CLAUDE.md AGENTS.md` → **zero**; the cited strings live in `docs/proposals/`. Keep only the one sharp instance: `.claude/skills/code-review/references/review-checklist.md:125,128,139`, where `#6981`/`#7210` are normative _merge gates_ in a skill `CLAUDE.md` tells contributors to load.                                                                               |
| **"Add `TEXRA_SUPABASE_URL` env-var override plumbing so people can self-host against their own backend"** | A client hardcoding its own vendor endpoint is normal; the publishable key at `src/auth/config.ts:35` is public by design and says so. "A different backend can be installed" is already the designed goal of `docs/proposals/2026-08-01-backend-decoupling-plan.md`, with a port. The real task is **delete or rewrite four stale files** (§4.5), not build plumbing for docs that were wrong.                                                                                                                                                                                                                                          |
| **"Withhold the Codex/Copilot proposals — they admit riding provider ToS violations"**                     | The Copilot route ships **no code** (`rg 'api.githubcopilot.com'` outside `docs/` → 0 hits), so that PRD documents a decision _not_ to ship on ToS grounds — diligence, not willfulness. The Codex admission is duplicated in shipping source at `src/auth/codex/codexConstants.ts:5-8` with the client id at `:19`, so removing the docs removes nothing, and the client id + endpoint are already public in Zed's and OpenCode's repos. What survives is one line: exempt these files from `2026-07-29-open-source-readiness.md`'s blanket "no business-sensitive material" clearance.                                                 |
| **"Falling back to the user's own API key when a model is out-of-tier"**                                   | `ModelHandler.ts:538-543` throws deliberately. Silently spending a user's personal OpenAI key when they believe they are on included access is exactly the quiet substitution `CLAUDE.md`'s "Silent degradation is a defect" rule forbids. The current error names both remedies, and `:551-554` shows the ordering was reasoned about.                                                                                                                                                                                                                                                                                                  |
| **"Add SPDX headers to 2,140 source files + a CI check that manifests match LICENSE"**                     | Optional under every license in play, and absent in most major OSS projects that ship one root LICENSE. The only concrete drift (`docs/package.json`) is already captured in §4.1.                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **"Add `.env.local`, `*.pem`, `*.key` to `.gitignore`"**                                                   | `find . -name '.env*' -not -path '*/node_modules/*'` → **nothing** in the tree. The one documented path (`packages/extension/src/extension.ts:180-182` reads literal `.env`) is covered by `.gitignore:4`, which has no leading slash and therefore matches at any depth (verified with `git check-ignore -v` on `packages/cli/.env`, `supabase/.env`, `docs/.env`). The real control — push protection — is already launch step 5 in `2026-07-29-open-source-readiness.md`.                                                                                                                                                             |
| **"Add a GitHub-token pattern to log redaction"**                                                          | `src/test-kernel/desktop/DesktopLogRedaction.vitest.mts:11,22` already asserts `ghp_…` is redacted, via `BEARER_PATTERN` (`src/logger/redaction.ts:10`, applied `:106`). The hypothesized leak path does not exist: `grep -rn 'x-access-token\|@github.com\|extraheader'` over `src/` and `packages/*/src` → zero. The token is stored in VS Code SecretStorage (`githubSubscriptionHandlers.ts:56`), not in loggable config.                                                                                                                                                                                                            |
| **"CLI secrets should use a keyring; plaintext `~/.texra/secrets.json` is a defect"**                      | `cliSecrets.ts:15` sets `0o600` and `jsonStore.ts:54-56,213-220` chmods the parent to `0o700` (with a follow-up chmod that fixes a pre-existing loose directory). Same posture as `gh`, `aws-cli`, `npm`, `kubectl`. The real defect is the false sentence at `TERMS_OF_SERVICE.md:38` (§5).                                                                                                                                                                                                                                                                                                                                             |
| **"Publish conversation-storage warnings — runs are written unencrypted"**                                 | Run storage sits under `~/.texra`, which is `0700` for anyone who has ever run `texra auth`; on the VS Code host it is inside the editor's globalStorage. `docs/guide/memory.md:95` already discloses the analogous case.                                                                                                                                                                                                                                                                                                                                                                                                                |
| **"Add a safe-harbor clause / narrow SECURITY.md's testing invitation"**                                   | `SECURITY.md` has an explicit `## Out of scope` section covering scanner output, missing headers, already-compromised machines, and bad agent output; the 5-day line is hedged in the same sentence; no bounty is offered and no active testing is authorized.                                                                                                                                                                                                                                                                                                                                                                           |
| **"Split CHANGELOG.md; reorganize `docs/`; write a CONTRIBUTING.md"**                                      | `CHANGELOG.md` is clean (3,047 lines, zero `#NNNN`, sync wired at `docs/package.json:7`). The CONTRIBUTING absence is tracked at `2026-07-29-open-source-readiness.md` and deliberately **held** until the license lands because soliciting contributions under all-rights-reserved with no CLA/DCO creates IP ambiguity — that reasoning is correct; unblock it in §7 Phase 3, don't treat it as a finding. Same for `CODE_OF_CONDUCT.md`. `.github/ISSUE_TEMPLATE/`'s absence is a routing decision (`README.md:143` sends issues to `texra-ai/texra-issues`), not an oversight.                                                       |
| **"Fix the 87 error-swallowing catch blocks / the dead-code baseline"**                                    | Already measured and budgeted: `.claude/skills/code-review/references/review-checklist.md` §15 records a 2026-07 audit of 880 catch sites (~87% legitimate) with an M1–M6 taxonomy and a named end-state. The knip baseline is 17 entries, 7 of which are false positives (`frontend/lean/VscodeIntegration.ts`, namespace-imported at `packages/extension/src/extension.ts:57,531`). Two are genuinely dead. Not a release concern.                                                                                                                                                                                                     |
| **"Reconsider excluding Windows from the gating test matrix"**                                             | `2026-07-29-open-source-readiness.md` §4.6 is a full page on exactly this, with the failure inventory, the reason for reverting, and a `TODO(windows-ci)` marker in `ci.yml` refreshed on 2026-08-01 (`e0ce8532d`). The maintainer decided this within the last 72 hours.                                                                                                                                                                                                                                                                                                                                                                |
| **"`coauthor-for-vs-code/` in history is an absorbed third-party project"**                                | `git log --format='%an <%ae>' -- 'coauthor-for-vs-code/*'` → 549 commits, **all** `14889516+LionSR@users.noreply.github.com`. It is this project's own predecessor (`e0eeb39d1 refactor: rename project from CoAuthor to TexRA`). No third-party license to carry forward.                                                                                                                                                                                                                                                                                                                                                                               |
| **"`coauthor-python/prototypes/xml_extraction/*.tex` exposes an unpublished manuscript"**                  | Published: Molpeceres, Lu, Cirac & Kraus, arXiv:2503.24330 / Phys. Rev. Research **7**, 033162 (2025), 21+19 pages. The `tum.de` address and affiliations are on the public paper; the appendices the finding called "unpublished supplementary derivations" are in the published version; the maintainer is a co-author. A courtesy item that rides free on B1's purge, nothing more.                                                                                                                                                                                                                                                   |
| **"Strip `Claude-Session:` trailers from 881 commits"**                                                    | The string appears in **zero** tracked files (`grep -rn 'Claude-Session' CLAUDE.md AGENTS.md .claude/ .github/` → nothing) — it is injected by the agent harness, so the prescribed fix has no target. The IDs are not credentials. And AI authorship is already visible from the author field regardless (3,980 commits as `Claude <noreply@anthropic.com>`).                                                                                                                                                                                                                                                                           |
| **"Sanitize the `6b9e775a6` scrub commit's contents from history"**                                        | Two of its three items are non-sensitive: the "machine path" is `/Users/me/Local/AI-Projects/coauthor/...` (`me` was already the placeholder), and `jntubmcgbhwtcktubelv` is published in DNS — `getent hosts remote.texra.ai` returns `jntubmcgbhwtcktubelv.supabase.co` as the CNAME, resolving to the same Cloudflare pair, so redacting a markdown line conceals nothing. The residue is one personal gmail, dwarfed by ~13,300 commits authored from `14889516+LionSR@users.noreply.github.com`. Update `2026-07-29-open-source-readiness.md` to say its clean bill covers the working tree and credential formats only — that is the whole action. |
| **"Add a `publicGuidePages` allowlist so nothing internal lands in `docs/guide/`"**                        | `docs/scripts/check-root-docs.mjs:111-113` already runs `markdownFilesUnder(docsDir)` **recursively** over the whole tree and rejects audit-, PRD-, or proposal-shaped basenames without a date prefix, anywhere. Publishing everything under `guide/` is the documented design (`publicDocs.js:27-29`).                                                                                                                                                                                                                                                                                                                                 |
| **"Bump `docs-deploy.yml`'s action majors"**                                                               | `@v4` vs `@v6` elsewhere, with no advisory and no failure mode named. The `git push -f "https://x-access-token:${GITHUB_TOKEN}@…"` at `:120-122` is the standard documented pattern, uses `env:` rather than an inline `${{ }}` expansion (`:109-110` — already the safe form), and the token is job-scoped and auto-masked.                                                                                                                                                                                                                                                                                                             |
| **"`.gitattributes`'s dead `*.lock.yml` rule is a credibility cost"**                                      | Both attributes are inert against a non-matching path. Fix it while adding `* text=auto eol=lf` (§4.3), but there is no separate finding here.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **"The Overleaf UI screenshot is a trademark risk"**                                                       | `docs/public/images/overleaf-git.png` is a 610×294 crop of Overleaf's Sync menu, used to illustrate the step documented at `docs/guide/working-with-overleaf.md:80`. Ordinary nominative use; already live on texra.ai.                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **"`README.md` is the Marketplace/npm body — decide the split first"**                                     | True and intentional, and documented three times by the maintainer: `packages/extension/.gitignore:1-7`, `packages/cli/scripts/copy-docs.mjs:3-5`, `packages/cli/.gitignore:1`.                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **"Publish the sign-up abuse policy to justify it"**                                                       | Do not reproduce live anti-abuse lists, thresholds, or bypass analysis in the public proposal. Keep the policy and its review in the private remediation tracker; the public launch requirement is a documented exception/appeal path and neutral user-facing copy. _(Moot under Option B.)_                                                                                                                                                                                                                                                                                                                                             |
| **"A suspected relay limit bypass"**                                                                       | Checked against the current routing and found unreachable. Operational details and supporting conditions remain in the private security notes; revalidate there if routing or limit policy changes.                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **"Move the six `supabase/`-importing vitest files before splitting"**                                     | Already enumerated verbatim, including the exact line number `RelayTokens.vitest.mts:81`, at `2026-08-01-backend-decoupling-plan.md`, which also specifies the replacement CI. The one residual — the `ci.yml:123-128` Deno step — is a 6-line deletion that fails loudly.                                                                                                                                                                                                                                                                                                                                                               |

---

## 7. Suggested sequence

Effort is maintainer-hours unless noted. **‖** marks work that parallelizes.

### Phase 0 — Decide (blocks everything). ~half a day of thinking, no code.

1. **Pick the license.** Recommendation: Apache-2.0. — 1h
2. **Pick the boundary.** Recommendation: `supabase/` and operational Supabase docs → private
   repo (§3.3), while `docs/supabase/remote-agents.config.json` stays public with
   `scripts/sync-remote-agents.mjs`; `prompts/agents/remote/` stays public and the Ultra gate at
   `SettingsRemoteAgentPromptController.ts:24-28` is deleted. — 1h
3. **Commit to the history rewrite** (B1). There is no viable alternative — ref deletion leaves
   objects fetchable by SHA. — 15m

### Phase 1 — Long-pole and irreversible. Start day 1.

4. **Email SXKDZ** (`Mr.SXKDZ@Gmail.com`) for relicensing consent on `f7528670` (B5). _This is the
   only item gated on someone else's response — send it before anything else._ — 30m + wait
5. **History rewrite** on a fresh `git clone --mirror` (B1). Purge `agents/*`, delete every
   historical version of this audit, delete or rewrite `origin/backend`, and then re-add only the
   redacted audit. Free riders: `coauthor-python/prototypes/`, `Notebooks/`, `*.vsix`. Verify object
   removal without printing confidential blobs, then delete the 35 merged + 32 stale branches in
   the same window. — 4-6h
6. ‖ **Attribution pass** (B2, B3): NOTICE/THIRD-PARTY-LICENSES with PocketFlow + gemini + Font
   Awesome + patched-openai entries; provenance headers in `src/agent/node/index.ts` and both
   `.sty` files; add the file to `verify-extension-package-invariants.mjs:42` and
   `electron-builder.yml`. — 4h
7. **Finish automation hardening** (B4): retain #9535's two non-persisting checkout flags and
   trusted-author gate, but remove the writable-`scripts/*` execution path or isolate it from
   credentials. Verify `BOT_PAT` scope and document the narrower `GITHUB_TOKEN` fallback. — 2h +
   administrator verification

### Phase 2 — Pre-flip cleanup. All parallelizable.

8. ‖ **License declarations** — all nine sites in one commit (§4.1). — 1h
9. ‖ **Repo identity sweep with `rg --hidden`** (§4.4), including `.claude/skills/` and
   `.github/workflows/`; fix `packages/{cli,extension,agent,desktop}` `repository.url` (prerequisite
   for provenance). — 3h
10. ‖ **Delete/rewrite stale `docs/supabase/`** (§4.5); move `AUTH_OPERATIONS.md` and
    operational SQL private, but keep `docs/supabase/remote-agents.config.json` public with
    `scripts/sync-remote-agents.mjs` (or move both together and update the script atomically). — 2h
11. ‖ **Inline the load-bearing proposal content** into `AGENTS.md` / review-checklist, then run
    `scripts/check-guidance-refs.mjs` as the split's acceptance test (§4.6). — 4h
12. ‖ **Windows unblock**: Node-ify the five extension scripts + two docs copies, add
    `* text=auto eol=lf`, add root `engines: {node: ">=22.13"}` + `.nvmrc` (§4.3). — 4h
13. ‖ **Register `texra` and `@texra` on npm**; set `"private": true` on `packages/extension`. — 30m
14. ‖ **Backend security fixes** (§4.2) — `auth-github` audience check, server-side
    accounting enforcement, and agent-CLI privilege ceiling. Under Option B the backend changes
    land in the private repo, but **all three still gate publication**; repository privacy is not a
    compensating control. Keep implementation details and adversarial test vectors private until
    deployed. — 2-3 days
15. ‖ **Exact dependency-license clearance**: scan every npm version resolved in `pnpm-lock.yaml`,
    inventory and review the complete Deno/JSR import graph, archive machine-readable results, and
    make the disallowed/unknown-license gate required. This is a launch prerequisite, not Phase 4
    automation. — 1d
16. ‖ **Small stuff**: delete `.vscode/settings.json:15`; fix `docs/guide/configuration.md:147`,
    `docs/guide/remote-agents.md:25`, `docs/dev/verification.md:19-21`,
    `docs/dev/texra-cli-checkout.md:4-6,30`; delete `docs/reference/index.md`; `sed` the 14
    `SKILL.md` descriptions; add `.mailmap`; wire `check:remote-agents` into `ci.yml:140`; add the
    boundary check to the `guidance-refs` job; pnpm-override `axios@^1.18.0`. — 3h total

### Phase 3 — Flip day.

17. **Rewrite `docs/guide/open-source.md`** in the same changeset as the flip (§5). — 2h
18. **Add `CITATION.cff`** + repoint `docs/guide/acknowledgments.md:7`. — 30m
19. **Write `CONTRIBUTING.md` + `CODEOWNERS` + DCO/CLA enforcement** — unblocked now that the
    license exists. Lead with "builds don't type check" per
    `2026-07-29-open-source-readiness.md`, expand R6/R8 with a link. — 3h
20. **Flip visibility.** Immediately: enable secret scanning + push protection (already launch step
    5 at `:410`); set the default workflow token to read-only; set `qna` on the Marketplace
    manifest. — 1h
21. **Delete `NPM_CONFIG_PROVENANCE: 'false'`** (both occurrences) — _only after step 9_ — and
    verify the provenance badge on the next `cli-v*` release. — 30m

### Phase 4 — Post-launch.

22. Automate generation and packaging of `THIRD-PARTY-LICENSES.txt`, archive the inputs used to
    produce it, and schedule maintenance updates. The required allow/deny decision remains solely in
    pre-launch step 15. — 1d
23. Deno matrix over all 8 `deno.json` directories + a `_shared/deno.json`; add `desktop:build` and
    `cli bundle` to the PR `build` job. — 1d
24. Wire desktop e2e into CI under `xvfb-run` (or delete the never-diffed baseline PNGs and say so);
    fix `menuLifetime.spec.ts:49`. — 1d
25. Resolve `packages/agent`: ship, `private: true`, or README. Optionally consolidate or index the
    21 checkpoint files already archived in `docs/dev/audits/`; do not schedule another relocation.
    — 1d
26. Re-enable `no-explicit-any` + `no-unused-vars` (~40 sites). — 4h
27. Baseline migration for `profiles`/`remote_agents`/`agent_whitelist`; fold the hand-run
    `docs/supabase/*.sql` into `supabase/migrations/` or archive them. — 2d
28. `TERMS_OF_SERVICE.md` §9 alignment (`:74`, `:38`) + the Service/code carve-out. — 2h

---

## 8. Coverage and gaps

**What was actually executed** (Linux, Node 22.22.2): a cold `pnpm install --frozen-lockfile`
(44.9 s), `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm test`
(806 files / 8,170 tests, 598.9 s, **zero failures**, no network or credentials needed),
`pnpm --filter texra build:fast` (produced a 172-file VSIX), `pnpm run desktop:build`,
`pnpm --filter @texra-ai/cli run bundle`, `docs npm ci && npm run docs:build`, five cheap CI gates,
`check:dead-code-ratchet`, and `pnpm audit --prod` — all green, `git status` clean throughout. A
full-history blob scan streamed all 219,097 objects / 78,672 blobs (86.4 MiB pack) through
credential regexes twice, plus all 8.1 MB of commit messages: **zero real credentials, zero PEM
keys, no `.env`/`.pem`/`.key`/DB dump ever committed**. Dependency licensing was resolved by
fetching all 735 packages from `registry.npmjs.org`, not guessed.

**Not checked, and needing a human:**

- **Legal review.** The TOS/license split (§3.3), the Apache-vs-MIT choice, whether the B5 consent
  email is sufficient in your jurisdiction, and — flagged but unresolvable from inside the repo —
  whether any MPQ employment or institutional IP agreement constrains the relicensing. Trademark
  registration status for "TeXRA" and the logo was not investigated; patent exposure was not
  assessed.
- **Dependency license precision.** The registry sweep resolved each package's `latest` dist-tag,
  **not** the exact version pinned in `pnpm-lock.yaml` — a historical license change on a pinned
  older version would not show up. Transitive **Deno/JSR** imports under `supabase/functions/**` are
  a separate graph and were not covered at all.
- **Visual inspection.** Four PNGs were opened and read as images
  (`walkthroughs/media/{texra-progressboard,file-selection,api-key-setup}.png`,
  `docs/public/images/overleaf-git.png`) plus three desktop e2e screenshots — all clean, synthetic
  content, PNG metadata dumped. **Not opened**: `vscode-compare.png`,
  `agent-model-selection.png`, `auto-extract-options.png`, and the four PDFs under
  `docs/public/examples/`. Their source `.tex` is synthetic, but a human should look.
- **Windows and macOS.** Every Windows claim in §4.3 is derived from reading the scripts plus
  documented `cmd.exe` / `core.autocrlf` defaults — nothing was executed on Windows. Deno is not
  installed here, so the three orphaned edge-function test suites were never run; whether they
  still **pass** is unknown, and that is the more interesting question than whether CI runs them.
  `pnpm --filter @texra/desktop test:e2e` was not run (needs a display).
- **GitHub-side state.** Not visible from a clone and all of it becomes public or semi-public on
  flip: **issue and PR bodies and comments**, wiki, Discussions, Actions run logs, repository
  secrets/variables, branch protection, the current default workflow-token permission, and whether
  "send secrets to fork PRs" is off. `BOT_PAT` and `DESKTOP_RELEASES_TOKEN` scopes are **inferred
  from usage, not verified**. Confirm `BOT_PAT` scope; the `GITHUB_TOKEN` fallback is repository-
  and job-scoped, so any multi-repository severity claim applies only if the PAT is present and has
  that reach. Issue/PR comment history in particular deserves its own pass before the flip, since it
  is the one large corpus this audit could not read.
- **Live rendered surfaces.** No claim about what texra.ai, the Marketplace listing, the npm page,
  `github.com/sponsors/texra-ai`, or the homebrew tap currently render was verified — everything is
  grounded in repo contents.
- **Not attempted**: any live exploitation of `remote.texra.ai`; RLS policy _correctness_ across the
  30+ migrations (the missing `CREATE TABLE`s make this impossible from the repo anyway); prompt
  provenance for the 21 hosted-agent YAMLs in `prompts/agents/remote/` (only `.github/prompts/` was
  read, and it is clean); the trace-viewer package; the extension's webview message-handler surface;
  and whether `contact@texra.ai` is monitored or GitHub private vulnerability reporting is enabled.
- **Method caveat.** The working checkout is **shallow** (`.git/shallow`, graft at `64de7c367`).
  `git merge-base --is-ancestor` and `git log main -- <old-path>` return misleading results for
  pre-2026-05 commits. B1's reachability was established through `git tag --contains` and
  `git ls-tree -r v0.15.10` instead, which is sound — but any future verification must be done on a
  full mirror clone, not this one.
