# Design red-flag audit, round 3 (read-only): what rounds 1 and 2 did not reach

Round 1 (`../2026-11-05-design-red-flags/`, areas A–F and L) audited the
harness core and the hosts' session paths. Round 2
(`../2026-11-06-design-red-flags-round-2/`, areas G–O) audited every source
directory outside it. Round 3 looks at what neither reached: the harness's
settings, schema and model layers outside the row model; the public surface
as a whole; the test infrastructure; the build and repo tooling; the trace
viewer, the VS Code commands and the bundled agents; and duplication that
crosses packages.

The rules, the red-flag species and the output format are round 2's
(`../2026-11-06-design-red-flags-round-2/BRIEF.md`), with three additions:

- A finding already in a round-1 or round-2 report, in the order note
  (`.agents/docs/proposed/architecture/2026-11-07-red-flags-round-2-and-order.md`),
  in the root designs note
  (`.agents/docs/proposed/architecture/2026-11-05-root-designs-effect-native.md`)
  or in `.agents/docs/refuted-candidates.json` is FOUND: do not repeat it.
  Cite it where it borders yours.
- The report ends with an "Effect-native mapping" table, as round 2's do:
  each finding, the primitive or structure that answers it, and the
  `node_modules/effect` (4.1.2) declaration you checked. There is no
  `Layer.scoped`; `Layer.effect` already provides a `Scope`.
- Re-read each finding against `main` at the commit you start from, and
  state that commit at the top of the report. Several packages are being
  changed in parallel (packages A–E of the order note): a finding inside a
  file an open package PR is rewriting is reported with that PR's number.

## Areas

| Area | Report                     | Scope                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P    | `P-settings-model.md`      | `packages/harness/src/shared/` outside the row model, the run state and the session view (C, B and R6 covered those): `shared/schemas/` (not the row kinds), `shared/config/`, `shared/state/`, settings catalogs and their surfaces (`packages/texra/src/shared/settingsView/texraSettings.ts`, `settingSurfaces.ts`), and `packages/harness/src/model/`. Key questions: the settings catalog, its rows and surfaces; schemas that restate each other; model capability and price tables beside llm-zoo; the config providers.                                                                      |
| Q    | `Q-public-surface.md`      | The public surface as a whole: `packages/harness/src/effect/`, the entry files, `config/api-reports/` and `packages/{harness,llm}/docs/api/`, read from the consumers' side (the app, the hosts, `example/`). Key questions: exports with no consumer outside their package; types exported for one consumer; entries or subpaths that forward; what an embedder must learn to start one run.                                                                                                                                                                                                        |
| R    | `R-test-infrastructure.md` | `src/test-kernel/support/`, `vitest.config.mjs` and its tier computation, `packages/*/test` support modules, `packages/desktop/tests/e2e/` helpers, the golden store generator. Key questions: a fake that is a second implementation of its port; helpers that restate production rules; fixtures several suites build differently; what a new suite must learn.                                                                                                                                                                                                                                    |
| S    | `S-build-tooling.md`       | `scripts/`, `.github/workflows/`, the root and package `package.json` scripts, `.oxlintrc.json`'s overrides, the esbuild and Vite configs. Key questions: one check implemented twice; lists of packages, paths or entries kept by hand in several places; scripts nothing runs; CI steps that restate a script.                                                                                                                                                                                                                                                                                     |
| T    | `T-app-surfaces.md`        | `packages/trace-viewer/`, `packages/extension/src/commands/` and `commands.ts`, `packages/extension/resources/agents/` and the other bundled prompts and skills. Key questions: the trace viewer's own copy of transcript reading or rendering; how a command is declared, registered and contributed; bundled agents' repeated prompt blocks and tool lists.                                                                                                                                                                                                                                        |
| U    | `U-cross-package.md`       | Duplication that crosses packages: the vocabulary-overlap pairs and predicate counts `npm run check:fact-spread` prints, literal sets and small types restated in two packages, helpers with the same job in harness `utils/`, texra `utils/` and a host. Key questions: which overlaps are one fact in two homes, and which are two facts that share words.                                                                                                                                                                                                                                         |
| V    | `V-compromises.md`         | Every compromise the work so far accepted, read again now that most packages have landed: the "Left", "Not done", "Refused", "Known gap" and "What we give up" sections of PRs #14713 and #14777 to #14792 (and their review replies), the refused entries added to `.agents/docs/refuted-candidates.json` since 2026-11-05, the order note's refusals and deferrals, and the R9 PR 1 record. Key questions: was the reason ownership, order or a PR still open (often gone now), or the design itself (still holds)? For each, the best design today, what it deletes, and whether it can land now. |
