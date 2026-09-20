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

| Measure                                                          | Value                                                                                |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Test lines vs production (suites + 6.7k support + 3k Playwright) | 170k vs 287k (0.59 : 1)                                                              |
| Suites                                                           | 529 suites, 161k lines: 174 pure (40k), 355 kernel (121k, 75 percent of suite lines) |
| Suites using a mock primitive                                    | 244 (46 percent); 408 `vi.mock` sites in 137 files                                   |
| Suites whose basename matches no production file                 | 405 of 529 (77 percent)                                                              |
| Support and fixtures                                             | ~5 500 lines; `FakePlatform.ts` 510, `setupPlatform.ts` 437                          |

Findings:

- 77 percent of suites carry no production basename. AGENTS.md permits a
  named cross-module scenario suite beside the path-mirrored module suite,
  so this is not a count of violations; it is a navigability cost. An agent
  refactoring `RunRegistry` cannot find its tests from the tree, and orphans
  cannot be detected by name.
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
2. Inject agent entry points into every suite the host-agent mock baseline
   names: the five largest (`chatSessionController`, `ExecuteCli`,
   `WorkflowRunCommand`, `ResumeCommand`, `History`) and the five that mock
   `@agent/index` (`CliSupabaseAuth`, `ConfigCommand`, `InitCommand`,
   `RunChatConfig`, `RunProgressRenderer`), plus the shared
   `support/agentCatalogMock.ts` they reach. The ratchet and its suite are
   deleted only when the baseline is empty; until then it shrinks. Keep the
   import-specifier ratchet.
3. Make every suite name its subject: a module suite mirrors its module's
   path; a scenario suite keeps its scenario name and declares the modules
   it covers in its `describe` header. Rename only module suites that
   mirror one module and do not say so. No mass rename.

## 2. Rulings and refusals as data

The architecture rulings ledger and the 2026-09-17 refuted list are prose.
An agent re-proposes `withPerKeyLane` onto `Semaphore` and `ModelRetryGate`
onto `Schedule` on every pass. Build
`config/ratchets/refuted-candidates.json` (id, symbols or paths, ruling
anchor). Two enforcement points, because a pure-tier suite has no PR body:
a pure-tier suite that fails when a refuted symbol changes shape without a
matching update to the baseline, and a CI workflow step, beside the
existing review workflows, that fails a PR whose diff touches a refuted
symbol without citing the ruling id in the PR body.

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
3. A gate keyed on an explicit completion marker, not on citations: a
   `proposed/` doc whose own status line or a "Landed" section declares its
   proposal complete fails until it moves; citing a merged PR as evidence or
   as a prerequisite stays legal, since a proposal can rest on landed work
   and still be open.
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
- Put the 63 versions `packages/agent` redeclares in a pnpm catalog so
  install time resolves them from one source; the package keeps its
  dependency names, since pnpm links a workspace package before any build
  script runs. It is the largest ungated two-sources-of-truth in the repo.
- Delete `p-defer`: zero production importers, but six kernel suites import
  it (`AgentDirectoryWatchers`, `BashTool`, `hostDraftRequests`,
  `ToolEditApprovalController`, `chatSessionController`,
  `CodexSessionCoordinator`), so the same PR converts those six to Effect
  `Deferred` before the manifest entry goes, or the suites fail at module
  resolution. Also delete the eight single-site
  packages that a few lines replace (`data-uri-to-buffer`, `deepmerge`,
  `mutative`, `fastest-levenshtein`, `perfect-debounce`, `pluralize`,
  `pretty-bytes`, `serialize-error`). `content-disposition` stays:
  `src/latex/arxivProcessor.ts:375` relies on it for RFC 6266 and RFC 5987
  decoding of `filename*=` and quoted parameters, and a hand-rolled parser
  is the prior behavior that dropped Unicode filenames.
  `diff-match-patch` stays: it has three importers, and
  `src/utils/text/diff.ts` relies on its fuzzy `patch_apply` to transplant
  an approved edit onto a file the user changed meanwhile; without it the
  fallback writes the model's content over those edits. `ipaddr.js` stays: its one caller is the SSRF
  boundary in `WebFetchTool.ts`, which default-denies every non-unicast
  range and normalizes IPv4-mapped IPv6, and Node's `net.isIP` gives no
  range classification.
- Retire `check-effect-migration-ratchet.mjs` (1 519 lines guarding an
  18-line baseline) as its categories reach zero; keep the `Effect.run*`
  boundary check, the only permanent rule in it.
- Close #12072, whose checklist is fully landed.

## 6. Acceptance

- `pure-tier-kernel-suites.json` is empty and deleted.
- `host-agent-mock-baseline.json` is deleted.
- `config/ratchets/refuted-candidates.json` exists and a suite enforces it.
- No doc under `.agents/docs/proposed/` (every class, not only
  `architecture/`) carries the completion marker of section 3, change 3; a
  landed section that names a merged PR while open steps remain is not, by
  itself, a failure.
- `config/ratchets/file-size-baseline.json` exists and shrinks.
