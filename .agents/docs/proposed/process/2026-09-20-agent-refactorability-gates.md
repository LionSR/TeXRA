---
created: 2026-09-20
status: proposed
---

# Agent-refactorability gates: what an autonomous refactor needs from the repo

Baseline: `main` at `3378a967`. Parent survey:
[post-refactor architecture survey](../architecture/2026-09-20-post-refactor-architecture-survey.md).
Owner direction this serves: the repo should be safe for an AI agent to
improve on its own. What exists is unusually strong (shrink-only ratchets, a
zero-baseline unexecuted-Effect check, a guidance-path checker, 13
architecture suites, one required CI check). What follows are the gaps that
make an agent waste effort or mislead itself.

## 1. Test estate

| Measure | Value |
| --- | --- |
| Test lines vs production | 170k vs 287k (0.59 : 1) |
| Suites | 529; 174 pure (40k lines), 355 kernel (121k lines, 75 percent) |
| Suites using a mock primitive | 244 (46 percent); 408 `vi.mock` sites in 137 files |
| Suites whose basename matches no production file | 405 of 529 (77 percent) |
| Support and fixtures | ~5 500 lines; `FakePlatform.ts` 510, `setupPlatform.ts` 437 |

Findings:

- AGENTS.md says "one suite per module, path-mirrored"; 77 percent of suites
  are named by scenario. An agent refactoring `RunRegistry` cannot find its
  tests, and orphans cannot be detected by name.
- `host-agent-mock-baseline.json` freezes 16 places where CLI and desktop
  suites mock `@agent/*` internals, which freezes the SDK's internal layout
  from outside it.
- `pure-tier-kernel-suites.json` lists 12 suites whose module under test
  reads the host ambiently. Each entry is a production defect recorded as a
  test-config exception.
- The fake-platform installer exists because production still reads
  ambients; fix the 12 reads and most of the installer's reason goes.

Changes:

1. Fix the 12 ambient reads; retire `setupPlatform.ts` and `FakePlatform.ts`
   for the suites that only needed them for that reason. Keep
   `tempDirPlatform.ts` and `fsTestUtils.ts`. Suites move to the tier that
   runs eight times faster.
2. Inject agent entry points into the five largest CLI suites
   (`chatSessionController`, `ExecuteCli`, `WorkflowRunCommand`,
   `ResumeCommand`, `History`); delete the host-agent mock ratchet, its suite
   and `support/agentCatalogMock.ts`. Keep the import-specifier ratchet.
3. Rename suites to their subject, or delete the mirroring rule from
   AGENTS.md. Renaming is recommended, since AGENTS.md already claims it.

## 2. Rulings and refusals as data

The architecture rulings ledger and the 2026-09-17 refuted list are prose.
An agent re-proposes `withPerKeyLane` onto `Semaphore` and `ModelRetryGate`
onto `Schedule` on every pass. Build
`config/ratchets/refuted-candidates.json` (id, symbols or paths, ruling
anchor) and a pure-tier suite that fails when a diff touches a refuted
symbol without citing its ruling id in the PR body or commit.

## 3. Docs whose status is typed, not derived

All 29 docs in `.agents/docs/proposed/` say `proposed`; at least seven of the
Effect-runtime series are executed (the run ledger shipped; CLAUDE.md
describes it as current architecture). Six `agent-sdk-readiness-reverify`
docs exist where one is current. The tree has no index and no glossary, and
`.agents/docs/README.md` forbids an index.

Changes:

1. Archive the spent runtime series (08-26, 09-03, the five 09-06 studies,
   the two 09-08 notes) with `git mv`; keep the 09-06 delivery plan and the
   09-15 completion protocol as authoritative. Collapse the six reverifies
   to the 09-17 one. About 10 100 lines leave `proposed/` and
   `implemented/`.
2. Add a 40-line index naming the authoritative doc per topic and linking
   the rulings ledger, and amend the README to allow it.
3. A gate: a `proposed/` doc that cites merged PR numbers or contains a
   "Landed" section fails; `implemented:` frontmatter is required to move.
4. Fix `approval.requested` in CLAUDE.md and AGENTS.md (the row is
   `request.opened`); extend `check-guidance-refs.mjs` to verify cited
   event-type literals, not only paths. Also delete the CLAUDE.md line
   forbidding `p-queue` and `async-mutex`, which no longer exist in any
   manifest.

## 4. Size and error-channel ratchets

35 percent of production code sits in files over 500 lines; 27 files exceed
1 000 and 7 exceed 1 500 (`openaiResponses.ts` 2 724,
`desktop/main/index.ts` 2 074, `turn.ts` 2 063, `sessionFold.ts` 1 983).
Add a shrink-only per-file line budget, the same mechanism as the other
ratchets. The `unknown` error-channel ratchet is specified in the
[Effect adoption](../simplification/2026-09-20-effect-facility-adoption.md)
note.

## 5. Apparatus

- Collapse the seven desktop artifact verifiers and two smoke runners into
  one `verify-desktop.mjs <stage>` (about 2 000 of 8 571 script lines).
- Derive `packages/agent`'s 63 redeclared dependencies from the root at
  build time; it is the largest ungated two-sources-of-truth in the repo.
- Delete `p-defer` (zero production importers) and the eleven single-site
  packages (`data-uri-to-buffer`, `deepmerge`, `mutative`,
  `diff-match-patch`, `fastest-levenshtein`, `perfect-debounce`,
  `pluralize`, `content-disposition`, `ipaddr.js`, `pretty-bytes`,
  `serialize-error`).
- Retire `check-effect-migration-ratchet.mjs` (1 519 lines guarding an
  18-line baseline) as its categories reach zero; keep the `Effect.run*`
  boundary check, the only permanent rule in it.
- Close #12072, whose checklist is fully landed.

## 6. Acceptance

- `pure-tier-kernel-suites.json` is empty and deleted.
- `host-agent-mock-baseline.json` is deleted.
- `config/ratchets/refuted-candidates.json` exists and a suite enforces it.
- `.agents/docs/proposed/architecture/` holds no doc whose landed section
  names a merged PR.
- `config/ratchets/file-size-baseline.json` exists and shrinks.
