---
created: 2026-10-28
status: proposed
---

# TeXRA 1.0: release scope, the pre-freeze set, and the order of work

Baseline: `main` at `8fcd0a3` (2026-10-28), re-checked at `fa6fb1e` later
the same day. Line references point into the former. The tracker is [#13736](https://github.com/LionSR/TeXRA/issues/13736);
this note is the plan it lacks: what 1.0 is, what must land before the
storage freeze, what explicitly waits, and the order.

## Problem

The last release is 0.40.10 (2026-09-06). `CHANGELOG.md` holds 349 unreleased
entries, six of them breaking. October's commits are 18 `refactor`, 9 `chore`,
7 `docs`, 5 `test`, 3 `fix`, 2 `feat`. #13736 has 27 of 34 sub-items done, yet
the two newest design notes
([general package](../architecture/2026-10-21-harness-general-package-design.md),
[tech-debt targets](../architecture/2026-10-27-tech-debt-target-designs.md))
together open nine lanes, about thirty slices and fourteen owner decisions.
Each audit has produced more work than it closed.

Two products with different readiness share one release definition. The app
(extension, desktop, CLI) is close: its storage layer, agent model and host
boundary are done. The harness as a general package is open-ended by nature,
and it is allowed to break at 0.x. Tying the first to the second is what keeps
1.0 from shipping.

The 10-21 design is also stale in the repo's favour, which hides how close the
app is:

- the root entry has 48 exports, not 246 (`config/api-reports/harness.api.md`,
  #14337);
- `config/ratchets/harness-deep-import-baseline.json` is empty for all five
  packages since #14347 (`f4c9efd`): no app or host file imports a harness
  internal;
- 90 of the 92 files in `packages/texra/src/tools` import only public entries;
- `run.start` v2 with `parent.call` landed (#14335), goal mode is a script
  (#14201), the golden store generates the same output twice (#14260 closed).

## Decision: what 1.0 is

**TeXRA 1.0 is the app release with a frozen storage format.** It ships the
extension, the desktop app and the CLI from one tagged commit, after
`npm run storage:freeze` (the `releasing` skill, step 1). `@texra-ai/harness`
and `@texra-ai/llm` stay 0.x and publish on their own schedule; their public
surface is not a 1.0 gate. The rulings ledger already says both are releasable
at 0.x (D11, as amended 2026-10-06).

What this means for the open design work:

- A change that alters stored bytes lands before the freeze or pays for an
  upcaster forever. That is the only hard gate.
- A refactor that leaves rows unchanged is not a 1.0 item, however large its
  design note. The run-lifecycle, host and storage-reader slices (L1 to L5,
  H1 to H4, S3 to S6) are all in this class and wait.
- Naming. The app keeps the TeXRA name: the Marketplace id, the `texra` CLI,
  the `texra.*` setting keys and the `.texra/` directories are user-facing
  and become permanent at the freeze. The harness's npm name is decided before
  its first publish, not before 1.0. The one preparation worth doing before
  the freeze is passing the setting namespace into the catalog as data
  (`packages/harness/src/shared/state/stateSettings.ts`), with stored keys
  unchanged, so renaming the harness later touches no stored byte.

## Goals

1. Ship `1.0.0-preview.1`, then `1.0.0`, from `main`, with frozen stored
   shapes that every later build reads through upcasters.
2. Every stored shape that is known to be wrong is fixed before the freeze.
3. Nothing lands before the freeze that does not change stored bytes or the
   freeze mechanism, apart from copy fixes and the release notes.

## Non-goals (explicitly deferred past 1.0)

- Lanes 1 to 9 of the general-package design, except the settings-namespace
  parameter in P5 below.
- The run-lifecycle redesign (L1 to L5 of the tech-debt note), the host dedup
  (H1 to H4), and storage readers S3 to S6, including the SQL `runs` view
  rewrite (`packages/harness/src/agent/runtime/historyQuery/views.ts`).
  #14242 (the `agent()` reuse scope reads the live parent link) and #13994
  are bug fixes that change no row; both are already fixed on
  `claude/top-tech-debts-survey-sgf9k8` (45c38e9, 961ad58) and land when that
  work is split into PRs, on neither side of the freeze. #14003 is closed:
  its fix reached `main` in #14335, and #14342 was closed as superseded.
- The `HistoryQuery` child-process protocol cleanup
  (`packages/harness/src/agent/runtime/historyQuery/HistoryQuery.ts`).
- Lifting the script door out of `dispatchPendingResponse`, the typed
  per-script services that replace its shared-value map, and the durable
  launch cap (`packages/harness/src/tools/delegation/agentChild.ts`).
- The three runtime performance readings (#12076) and any `Metric`.
- test-kernel deep imports (178 of 275 suites); the plugin-author subset of
  `./host`; pruning general helpers from `./plugins`. The last two precede
  the first npm publish, not 1.0.
- The `codecVersion` read rule: `packages/harness/src/agent/runtime/storedTurn.ts`
  decodes live payloads with llm's `Literal(1)`, so a move to codec 2 must
  change the reader first. It changes no stored byte, so it is not
  freeze-gated; it is gated on llm's codec bump.
- The UX roadmap items.

## Evidence per area

Five read-only audits of the tree on 2026-10-28, each checked against the
code before it was used here.

**Effect-native.** The harness holds no Promise orchestration: over 87k lines,
`new Promise` 0, `.then` 1 (the sandbox prelude), `Effect.run*` 0 outside the
worker entry, every `async` a comment or the guest-script boundary. What
remains is structural: one `AbortController` and about ten mutable fields in
`packages/harness/src/agent/runtime/childRunLoop.ts` (D1 of the tech-debt
note), hand-built `Map<seq, Deferred>` ordering gates in
`packages/harness/src/agent/runtime/loop/toolUseDispatch.ts`, and the
`HistoryQuery` class. None of it changes a row. Verdict: sufficient for 1.0.

**Codemode.** The design holds. Two things touch the freeze:

- `script.call` v1 (`packages/harness/src/shared/schemas/runHistoryEvent.ts`)
  stores `callId` and `stageId`. The schema's own check requires `callId`
  to equal the script call id, a slash and `seq`, and the dispatcher builds
  `stageId` from the script's `logId` (`toolUseDispatch.ts`). Both restate
  a fact the row already holds. Drop them or keep them, now.
- Live result delivery to the guest follows `Queue.offer` order
  (`packages/harness/src/agent/codeSandbox/codeSandbox.ts`, the `settled`
  queue), while replay follows commit order (`toolUseDispatch.ts`,
  `replayOrder`). The offer runs in each call's own fiber after its result
  commits, so nothing ties offer order to commit order; an order-sensitive
  script (`Promise.race`) could fail with `ScriptDiverged` on resume. This
  is a reading of the code, not a reproduced failure. No test covers replay,
  divergence or reuse. The fix is in the runtime and changes no row, but a
  1.0 that promises resume must have it. The replay half has moved since
  `8fcd0a3`: d3a64e6 on `claude/top-tech-debts-survey-sgf9k8` gives the
  scheduler the replay list and deletes the door's own `Deferred` chain. The
  live path still delivers from the `settled` queue, so R12 is still open.

**Storage.** Effect 4's own `effect/sql`; every statement a constant string
with `?` binds; the "nothing below the codec reads a payload field" rule holds
under test. Three freeze items:

- **Media by workspace path** (`packages/harness/src/shared/schemas/followUp.ts`,
  `request.ts`, `fileFields.ts`; D4 of the tech-debt note, #13874). An
  upcaster cannot turn a path into a digest, and pasted files are deleted
  after three days, so this cannot land after the freeze. Done on
  `claude/top-tech-debts-survey-sgf9k8` (8994563, not yet a PR):
  `followup.queued` and `log` move to v3 with a `media` list of name, MIME
  type and digest (`StoredMediaSchema`), and the composer, fork-from-here
  and the request lose their path fields. `run.config.mediaFiles` stays a
  path list on purpose (43c10db): it is a launch input that templates,
  document tasks and "Run again" read by path, and the opening message
  already holds the bytes by digest. The `approve` branch of
  `request.opened` keeps `mediaFiles` paths for the same reason: a proposal
  names workspace files a model or script chose, and the launched child
  commits their bytes by digest in its opening batch. Pasted chat media
  reaches a run only through `followup.queued`, which is now by digest.
- **Upcaster numbering.** `upcast[i]` maps stored version `i+1` to `i+2`
  (`packages/harness/src/shared/schemas/rowVersions.ts`), and the freeze test
  demands `upcasts >= version - 1`
  (`src/test-kernel/schemas/rowVersions.vitest.ts`). Nine kinds are at v2 and
  `run.config` is at v6, all with empty `upcast`. Reproduced on 2026-10-28:
  after `npm run storage:freeze` (50 frozen files, the suite green), bumping
  `run.config` to v7 with one identity upcaster fails the suite with
  "run.config v6 has no upcaster chain to v7: expected 1 to be greater than
  or equal to 6". The test is not being pedantic: `decodeRow` applies
  `upcast.slice(version - 1)`, so with one upcaster a v6 row would get
  `slice(5)` of a one-element array, an empty list, and the upcaster would
  be skipped without an error. The numbering must start at the released
  floor in both the registry and the codec. Current values share one
  version with no upcast step
  (`packages/harness/src/controllers/session/currentValues.ts`), and the
  `app-state` family's schema is any JSON
  (`packages/harness/src/shared/session/valueFamily.ts`), so its frozen file
  protects nothing. No kind has a real upcaster today and no test runs one
  through `decodeRow` (`packages/harness/src/controllers/session/rowCodec.ts`).
- **Golden store.** Output still depends on whether TeX tools are installed
  (#14338; `packages/cli/scripts/generate-golden-store.mjs`).

**Self and goal mode.** The concept converged: a goal is a background script
that calls `self()` in a loop, and `self()` is awaited delegation
(`packages/harness/src/tools/codemode/SelfTool.ts`,
`packages/harness/src/tools/plan/goalScript.ts`). What is not final is what
it writes:

- `run.config.script` stores the generated template, prompt text included
  (`packages/harness/src/tools/codemode/backgroundScript.ts`). The row should
  hold a `builtIn:goal` module import, not a program body.
- The approval policy carries `goal: kind[]` plus a derived `own: 'parent'`
  that exists only to end the goal's grants on resume
  (`packages/harness/src/shared/approvalBypassKind.ts`). A goal-specific
  lifetime rule sits in the general grant shape, and the user has no re-arm
  action.
- Not a shape problem, checked and dismissed: `SelfTool.ts` reads the
  recorded launch parent, and
  `packages/harness/src/shared/session/runRelation.ts` reads the attached
  one. Both are right for their purpose. `self()` needs the conversation the
  goal was launched from to fork it, and a delivery's `relation` names where
  the run stands now. The only way a goal is detached is a Stop of its
  conversation (`detachActiveChildren` in
  `packages/harness/src/agent/runtime/runRegistry.ts`), after which
  `needsWake` in `packages/harness/src/shared/session/runFacts.ts` holds the
  result for the next resume whether the relation reads `child` or `peer`.
  Follow-up delivery ids are opaque strings in several formats; an id's
  format is not a stored shape, so it is not freeze-gated either.

**Agents.** Done. 35 bundled YAML files, one flat persona plus at most one
plugin block, no second format, user docs complete
(`docs/guide/custom-agents.md`). The freeze makes the persona fields and the
`task:` block a user contract.
`.agents/docs/implemented/architecture/2026-09-24-plugin-architecture.md`
still lists a `continuation` field that `Plugin` no longer has and calls the
block schema Zod.

**Imports.** The app-to-harness boundary is closed. At `8fcd0a3` one row
remained, `emitAppSignal` from the harness's `eventBus/`, used by two GitHub
plugin files; #14347 (`f4c9efd`) made `AppSignals` a process service in
`packages/harness/src/platform/appSignals.ts`, exported from
`@texra-ai/harness/host`, and deleted the `eventBus/` module and its alias.
On `main` the baseline is empty for every package and #14313 can close. The
empty baseline file and its suite can go whenever the ratchet rule for
finished baselines (D6 of the tech-debt note) allows; nothing waits on it.

## Design rule: delete the mechanism, do not patch it

The owner's direction (2026-10-28): write each of these the smart way, so
the complexity goes away, rather than keep handling it. Applied to the items
above, three mechanisms disappear.

**Rows evolve additively; the golden store is the freeze.** This argues
against ruling Q2 of the storage design ("released rows are read forever
through upcasters, in the codec only") and asks for the rule `config.json`
already has (ruling D12): from 1.0, a released row kind only gains optional
fields, a released field keeps its meaning, and a change that cannot be made
that way is a new kind name, with the old one retired as kinds are retired
today. Under this rule there is nothing to upcast, so the per-kind `upcast`
arrays, `readableFrom` and `pluginFactFloor`
(`packages/harness/src/controllers/session/rowCodec.ts`), the dispatch on
`CURRENT_VALUE_VERSION`, the `upcasts >= version - 1` test and the frozen
JSON fingerprints with their `--mode freeze` run are all deleted. The
`version` column stays as a write stamp, read only by the "a newer build
wrote this" refusal. What remains as the freeze is one dynamic check that
already exists: `src/test-kernel/fixtures/storage/golden-1.0.sql` decodes
and reduces to the same facts in every later build
(`src/test-kernel/controllers/session/goldenStore.vitest.ts`). It catches a
new required field, a retyped field and a changed meaning, because the
golden rows stop decoding or stop reducing to the asserted facts. One
assertion is added to it: every kind in `ROW_KINDS` appears in the golden
store, so no kind is unprotected by accident. The cost of a breaking change
after 1.0 is a new kind and a reducer that reads both while old data lasts,
which is the same work an upcaster is, placed in the one owner of the fact
instead of in a codec stage with its own numbering. If Q2 stands, the
fallback is P1 as a keyed table: `upcast` becomes a record from stored
version to step, applied in a loop until the current version; the count
check is deleted. About 20 lines.

**The sandbox door has one path.** The run loop's own rule is that live and
resume are one function over the rows. The script door breaks it in one
place: live, it hands results to the guest from a queue in finishing order;
on resume, from the rows in commit order. Make the live path read the same
source as the replay path: the guest receives each call's result when the
run state shows it committed, in commit order, whether the call ran a
moment ago or in an earlier process. The `settled` queue, the `delivered`
map of `Deferred`s and the `handedBack` gate go; the ordering question and
its tests go with them, since there is one order and it is the store's.
`RunCell` exposes `current`; the door needs the stream of applied rows
behind it, which the session view's `SubscriptionRef` already carries.

**A grant names its grantor; its lifetime is derived.** Instead of the
`goal: kind[]` array and the derived `own: 'parent'` marker that exist to
end a goal's grants when a resume ends the goal
(`packages/harness/src/shared/approvalBypassKind.ts`), a grant row records
which run granted it. Whether the grant still holds is read from that run's
lifecycle rows at resolution time: a goal's grants end when the goal ends,
and a resume that does not resume the goal ends them the same way, with no
marker written. One owner per fact, and the grant shape has no goal in it.

Two items stay as they are because they are already the simple form:
content addressing for media (P3) and a module reference for the goal
program (P2).

## Decisions this plan needs

| #   | Decision                                                                                                                                              | Recommendation                                                                                            |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| R1  | 1.0 is the app with a frozen store; harness and llm stay 0.x                                                                                          | Yes. Everything below assumes it.                                                                         |
| R2  | Media stored by blob digest (D4)                                                                                                                      | Yes. Already written (8994563 on the tech-debt branch); needs its own PR.                                 |
| R3  | `wakeAt` on `run.position` now, or later                                                                                                              | Later. It is an optional field, which the additive rule adds at any time.                                 |
| R4  | `script.call`'s `callId` and `stageId`                                                                                                                | Drop both; derive at read.                                                                                |
| R5  | Goal stored as a `builtIn:goal` module import, not a template body                                                                                    | Yes.                                                                                                      |
| R6  | Goal grants: a grant that names its grantor, with its lifetime derived from the grantor's rows                                                        | Yes. Deletes `goal: kind[]` and `own: 'parent'`; a resume that skips the goal asks again.                 |
| R7  | AppSignals (#14313)                                                                                                                                   | Done by #14347: a process service on `./host`. Close #14313.                                              |
| R8  | `childRunLoop.ts` off the `AbortController` residents (D1)                                                                                            | Yes, after 1.0. No row changes.                                                                           |
| R9  | Setting namespace as a catalog parameter, stored keys unchanged                                                                                       | Yes, before the freeze; it is the one rename preparation that costs nothing later.                        |
| R10 | The Promise entry of the general-package design                                                                                                       | Deferred with the rest of that design.                                                                    |
| R11 | Rows evolve additively from 1.0; the golden store is the freeze (against ruling Q2)                                                                   | Yes. Deletes the upcast arrays, the floors, the fingerprints and the freeze mode.                         |
| R12 | The sandbox door reads results from the committed rows live as well as on replay                                                                      | Yes. One path; the ordering problem and its tests do not exist.                                           |
| R13 | Collapse the five `ExhaustionReason` literals (`shared/schemas/errors.ts`), stored in the `failed` attempt row through `RetryErrorInfoSchema`, to one | Decide now: a literal removed after the freeze is a breaking change. If wanted, it rides the P3 shape PR. |

## The pre-freeze set

Each item is one PR unless noted. Sizes are estimates from the audits. A PR
here changes stored bytes, the freeze mechanism, or copy; nothing else.

| #   | PR                                                                                                                                                                                                                                                                                                                                                                                                                                     | Rows changed                                                 | Size     | Done when                                                                                                             |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | -------- | --------------------------------------------------------------------------------------------------------------------- |
| P1  | Additive rows (R11): delete `upcast`, `readableFrom`, `pluginFactFloor`, the current-value version dispatch, the fingerprint half of `rowVersions.vitest.ts` and the `storage:freeze` script; add the kind-coverage assertion to `goldenStore.vitest.ts`; reword the storage sections of `packages/harness/AGENTS.md` and the storage design. Fallback if Q2 stands: `upcast` as a keyed record applied in a loop, count check deleted | none (mechanism)                                             | net −150 | `goldenStore.vitest.ts` names every kind in `ROW_KINDS`; no code reads a row's version except the newer-build refusal |
| P2  | Goal rows (R5, R6): `builtIn:goal` module import in `run.config.script` (the `scriptModules` mechanism in `packages/harness/src/tools/plugins.ts` already exists); a grant records its grantor and its lifetime is derived                                                                                                                                                                                                             | `run.config`, `approval.policy` / `run.start.approvalPolicy` | ~80      | No prompt text in any row; `approvalBypassKind.ts` has neither `goal` nor `own: 'parent'`                             |
| P3  | Media by digest (R2): written as 8994563 and 43c10db on `claude/top-tech-debts-survey-sgf9k8`; to land as its own PR, separate from that branch's H1/H2 and llm refactors, with the golden store regenerated in it                                                                                                                                                                                                                     | `followup.queued` v3, `log` v3                               | written  | The PR is open and merged; no `mediaFiles` path field remains on a follow-up, user or request row (#13874)            |
| P4  | Codemode: drop `script.call`'s derived fields (R4); the LIVE path reads results from the committed rows as the replay path already does after d3a64e6 (R12), deleting the `settled` queue in `codeSandbox.ts`; one regression test, a `Promise.race` script resumed from its rows                                                                                                                                                      | `script.call` v2                                             | net −40  | A script with `Promise.race` over two calls resumes identically from its rows; the door has one delivery function     |
| P5  | Namespace as data (R9): `settingsCatalog(rows, { namespace })`, prefixed at the store boundary, stored keys unchanged                                                                                                                                                                                                                                                                                                                  | none                                                         | ~40      | `stateSettings.ts` has no literal `texra.` prefix; TeXRA's hosts pass `'texra'`, the SDK default is `'harness'`       |
| P6  | Golden store independent of installed TeX tools (#14338)                                                                                                                                                                                                                                                                                                                                                                               | none (fixture)                                               | ~20      | The generator's `--twice` check passes on a machine with and without TeX                                              |
| P7  | Copy and doc drift: the plugin-architecture note (`continuation`, Zod, `requires`, `scriptModules`); the `import` contradiction in `docs/guide/multi-agent-workflows.md`; goal copy in `packages/texra/src/tools/pluginCards.ts` and `packages/texra/src/ui/copy/delegationApproval.ts`; the stale "#14201 open" line in the 10-21 design                                                                                              | none                                                         | ~40      | Every statement about goal mode in UI and docs matches `goalScript.ts`                                                |

Order: P1 first (it decides what "frozen" means for every PR after it), then
P2 to P6 in any order, P7 last. P3 is the one PR that already exists as
commits; it only needs splitting out and can go first if P1 is slow. Seven
PRs, net about 50 lines added: the three mechanism deletions pay for the
shape changes.

## Coordination record (2026-10-28)

What else is in flight that touches this plan, as of `main` at `fa6fb1e`
(#14344 merged):

- **A second 1.0 PRD exists.** Draft PR #14352 (`docs/harness-1-release-prd`)
  adds `.agents/docs/proposed/architecture/2026-10-28-harness-1-release-prd.md`
  and claims the same index row. Its scope is harness-first (public SDK,
  programmable calls, SQL, an external plugin package, fourteen acceptance
  scenarios). It agrees with this note on storage ("execution changes do not
  trigger storage migrations"; no per-family version framework) and disagrees
  on R1. Only one note can own the topic; the owner picks, and the survivor
  absorbs the other's useful parts (its integration order for the nine open
  PRs, this note's pre-freeze set and mechanism deletions). Neither #14352
  nor #14350 carries a session trailer; both are the owner's or a Codex
  session's.
- **The Q2 fallback is already written.** Draft PR #14350
  (`codex/call-contract-cleanup`) indexes upcasters from the readable floor,
  keeps the first and latest frozen versions in the release check, and adds
  one codec test. Under R11 it is superseded; under Q2 it is P1.
- **`claude/top-tech-debts-survey-sgf9k8`** (the tech-debt session, 23
  commits past #14335, 93 files, no PR yet) bundles P3, the replay half of
  P4, the fixes for #14242, #13994 and #13874, the H1/H2 approval store and
  two llm consolidations. Confirmed by that session: H1/H2 add no row kind
  or field (the approval store is a `SubscriptionRef` on the session view;
  the durable fact stays `request.decided.decision.content`; the RPC
  `PROTOCOL_VERSION` moves 34→35, which is wire, not storage); its L2 to L5
  lifecycle work on worktree branch `l25` identifies an activation by its
  `run.activate` commit and stays off `ApprovalPolicySnapshotSchema`; and
  when PRs open, D4 (8994563 with its golden regeneration and 43c10db) goes
  alone as the one shape PR, with the approval store, the llm refactors and
  the dispatcher changes in separate PRs that touch no `rowVersions.ts`.
- **`claude/single-owner-refactor`** (the dual-systems session, local,
  rebased on `fa6fb1e`): partial S1, S4 and S5, the onboarding refresh (§3
  of the tech-debt note), one wording for a failed model call, with parallel
  workers on H4, H5, V2 (#14321's onboarding-key move), M1 and M4. By its own
  check, no commit changes a row schema, a version, the codec or current
  values, and its workers are told to skip S2, D4 and D5. It deferred one
  lead that would change stored bytes, the `ExhaustionReason` collapse (R13),
  to this plan's shape PR. Its later commit "one random-id minter" makes new
  trace, card and `logId` values 36-character UUIDs instead of 21-character
  nanoids; ruled not a shape change here, as for the delivery-id formats: no
  row schema constrains those ids and run ids keep their 12-hex form. The
  one format-aware reader is the golden-store normalizer
  (`packages/cli/scripts/generate-golden-store.mjs`, its `NANO` and `UUID`
  patterns), so that branch regenerates the fixture and runs `--twice`.
- **Nothing else in flight changes a row.** #14340, #14343, #14346, #14348,
  #14349, #14351 and `claude/run-events-replay` were read; none touches a
  stored schema. #14342 was closed as superseded: its completion change
  reached `main` through #14335. The triage session confirmed this
  classification and is not relabelling #13736's tree.

## Freeze and release

1. **Freeze PR.** Regenerate `golden-1.0.sql` from the release commit, and
   change the "Compatibility and format retirement" section of the root
   `AGENTS.md` and the "Storage format" section of `packages/harness/AGENTS.md`
   to the additive rule: a released kind gains only optional fields, a
   released field keeps its meaning, a breaking change is a new kind. (Under
   the Q2 fallback, this step is `npm run storage:freeze` and the upcaster
   wording instead.)
2. **Release notes.** The 349 unreleased entries become one 1.0 section with
   a migration guide up front: no import of 0.x state, OpenRouter and Copilot
   gone, model names as `provider/id[@effort]`, the helper-model key, the
   Anthropic bearer header. The per-fix bullets follow.
3. **Preview.** `1.0.0-preview.1` through the preview path of #12168; its
   last open box is verifying the channel, which only the owner can do.
4. **Release candidate**, then `1.0.0` by the `releasing` skill.

Owner-only items on this path: the preview verification (#12168), the
`GOOGLE_API_KEY` secret (#13722), and the relay sunset (#10920), which is
independent of the tag.

## Acceptance for 1.0

- `golden-1.0.sql` is regenerated from the release commit, holds a row of
  every kind in `ROW_KINDS`, and `goldenStore.vitest.ts` passes.
- Every row kind in `config/storage/row-kinds-ever.json` is current or
  retired.
- No stored schema holds a workspace path for media, a program body for a
  goal, or a derivable id.
- A script that issues concurrent calls resumes from its rows without
  `ScriptDiverged`.
- `1.0.0-preview.1` installs from the preview channel on all three hosts.

## Risks

- **The tech-debt branch mixes row changes with refactors.** If it lands as
  one PR, the golden store and `rowVersions.ts` move inside a 93-file
  diff and the freeze review loses its one-shape-at-a-time property. The
  split is the mitigation.
- **P1 reverses a ruling.** Q2 was taken on 2026-09-28 with upcasters in
  mind; the additive rule trades a codec stage for a reducer that reads two
  kinds during a breaking change. If the owner keeps Q2, the keyed-record
  fallback is the same size as the defect fix and nothing else in the plan
  moves.
- **The golden store must cover every kind.** It is the only freeze check
  under R11. The coverage assertion in P1 makes a missing kind a red test,
  and P6 makes the fixture independent of the machine.
- **Two claims are from reading, not from running.** The live delivery-order
  race in codemode and the golden store's dependence on installed TeX tools
  (#14338) were not reproduced here; P4 and P6 confirm each before fixing it.
- **Scope creep from the design notes.** Each PR above is bounded by "changes
  stored bytes or the freeze mechanism". A reviewer who finds a refactor in
  one of them should ask for it to be split out, not widened in.

## Verified

- Read on `main` at `8fcd0a3`: the two design notes and the tech-debt survey,
  #13736, #13724, #13727, #12168, the rulings ledger's 1.0 sections,
  `rowVersions.ts` (versions and the `upcast[i]` comment),
  `rowCodec.ts` (`upcast.slice(version - 1)` and the readable floor),
  `rowVersions.vitest.ts` (`upcasts >= version - 1`), `SelfTool.ts` (the
  launch parent as the fork source), `runRelation.ts`, `runRegistry.ts`
  (`detachActiveChildren`, the one writer of `run.detach`), `runFacts.ts`
  (`needsWake`), `codeSandbox.ts` (the `settled` queue) and
  `toolUseDispatch.ts` (`replayOrder`, the `script.call` writer, `stageId`),
  `runHistoryEvent.ts` (the `callId` check), `backgroundScript.ts` and
  `goalScript.ts` (the template stored in `run.config.script`),
  `approvalBypassKind.ts` (`own: 'parent'`), `followUp.ts`, `request.ts` and
  `fileFields.ts` (`mediaFiles` as paths), `pastedImageUtils.ts` (the
  three-day deletion), `currentValues.ts` and `valueFamily.ts`,
  `harness.api.md` (48 exports), the deep-import baseline (one specifier),
  and the import graph of `packages/texra/src/tools` (2 of 92 files reach a
  harness alias). Re-checked on `origin/main` at `fa6fb1e`: `eventBus/` is
  gone, `platform/appSignals.ts` exists, and the baseline is empty for all
  five packages.
- Counted with grep: Promise, `async`, `Effect.run*`, `AbortController` and
  Effect primitive uses per package.
- Run on 2026-10-28 after `corepack pnpm install`:
  `src/test-kernel/schemas/rowVersions.vitest.ts` (52 passed, 1 skipped);
  `npm run storage:freeze` (50 files written, 53 passed); the same suite with
  the frozen directory present (52 passed); the suite after bumping
  `run.config` to v7 with one identity upcaster (1 failed, the message quoted
  above). The frozen directory and the bump were reverted afterwards.
- Read on `origin/claude/top-tech-debts-survey-sgf9k8` at `8bd63f2`: the
  commit list past `main`, `rowVersions.ts` (`followup.queued` and `log` at
  v3), `followUp.ts` (`media: StoredMedia[]`), `storedTurn.ts`
  (`StoredMediaSchema`), `request.ts` and `fileFields.ts` (paths kept), and
  the messages of 8994563, 43c10db, d3a64e6, 7084636, 45c38e9 and 961ad58.
  Read #14350's diff and #14352's note in full.
- Not run: the golden generator, the sandbox, or any E2E.
