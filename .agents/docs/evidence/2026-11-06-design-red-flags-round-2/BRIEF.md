# Design red-flag audit, round 2 (read-only): the areas round 1 did not cover

Round 1 (`.agents/docs/evidence/2026-11-05-design-red-flags/`, areas A–F and
L) audited the harness core: child runs, the session store, the row model,
the model-call path, the run loop and tool engine, and the three hosts'
session paths. Its findings were synthesized into
`.agents/docs/proposed/architecture/2026-11-05-root-designs-effect-native.md`
(R1–R10), of which R1–R5, R7 and the first half of R8 landed (PR 14769), and
the CLI service's lifetime landed (PRs 14771, 14772). Round 2 audits
everything round 1 did not read: the app layer, the tool plugins, the LaTeX
and document pipeline, the UI kit and views, the host packages, the harness's
built-in tools and platform, and llm's providers.

Same rules as round 1. You are auditing one area of /home/user/TeXRA for
DESIGN problems in the sense of Ousterhout, _A Philosophy of Software Design_.
Find the species named below in your area, with evidence, and for each one
propose the design that would make it disappear.

Do NOT edit any file except the one report file your task names. Do NOT run
tests or builds. Read code with cat/sed/grep (or Read/Grep). Cite every claim
as `path:line`. Grep consumer counts for every symbol you propose to delete or
collapse (production corpus: `packages/*/src`; non-production:
`src/test-kernel`, `packages/*/test`, `docs`).

## Read first (10 minutes)

- `/home/user/TeXRA/AGENTS.md`: "TeXRA 1.0 direction", "Effect", "Design
  guardrails", "Plain names and comments". The app (`packages/texra/src`) and
  the hosts are Effect-native targets too: `new Promise`, `.then(`, hand-rolled
  waiters and timers there are red flags even where oxlint allows them.
- `/home/user/TeXRA/packages/texra/AGENTS.md` (the app and its UI toolkit) and
  `/home/user/TeXRA/packages/extension/src/AGENTS.md` (webviews, error
  surfacing), whichever covers your area.
- `/home/user/TeXRA/.agents/docs/proposed/architecture/2026-11-05-root-designs-effect-native.md`:
  the Summary, the root that borders your area, "Order", and "Findings by
  area". A finding whose root is listed there is FOUND; do not repeat it, but
  you may cite it and add a new angle.
- `/home/user/TeXRA/.agents/docs/proposed/architecture/2026-11-06-root-designs-pr1-compromises.md`
  §3 "Red flags that stand" and §4: found, do not repeat.
- `/home/user/TeXRA/.agents/docs/proposed/architecture/2026-11-06-cli-service-root-causes.md`
  (areas G, K and N): the CLI service's lifetime, wire, windows and attach are
  found; do not repeat.
- `/home/user/TeXRA/.agents/docs/proposed/simplification/2026-11-03-fewer-processing-options.md`
  and `2026-11-03-storage-errors-and-stop-paths.md`: the standing inventories
  of options and error kinds; do not re-list an entry, add to it.
- `/home/user/TeXRA/.agents/docs/refuted-candidates.json`: refactors
  investigated and refused. Do not propose one again without new evidence.
- One round-1 report, so you match its depth and format:
  `/home/user/TeXRA/.agents/docs/evidence/2026-11-05-design-red-flags/E-loop-tools.md`.

## The red flags to look for (name the flag in each finding)

- Shallow module: interface nearly as complex as the implementation; many
  small exported functions each doing one step of one caller; a class whose
  methods are its fields' getters.
- Information leakage: a protocol/invariant (a message shape, an id grammar,
  a file layout, which setting gates which path, how a host answers a
  request) known by several modules.
- Temporal decomposition: one operation split into modules by WHEN things
  happen (prepare / run / finish) rather than by what knowledge they hide.
- Overexposure / pass-through: a method or module that forwards; an
  option/flag/mode that is a decision the code refused to make ("No option
  for a special case" in AGENTS.md). Includes a boolean or literal parameter
  whose value is constant per caller, a callback parameter with one shape, a
  column of a declarative table that is constant or derivable, a port with
  one implementation.
- Special and general code mixed: a general path with branches for one
  caller's case; a base class with hooks one subclass fills.
- Conjoined methods / vague names: a file whose name covers one of several
  unrelated things it holds (`helpers`, `utils`, `support`, `Base`).
- State machine in optional fields / sentinel values: `x?: T` combinations or
  a literal meaning "none", where a type or a fiber/scope/Deferred would carry
  the state.
- Reinvented Effect, Node or host primitives: hand-rolled waiter counts,
  readiness Deferreds, observers, uninterruptible masks, generation counters,
  "drained" promises, polling loops, idle sweeps, caches with TTL, where
  Fiber/Scope/Semaphore/Queue/PubSub/SubscriptionRef/Latch/RcMap/Stream/
  Schedule already is the thing; `Effect.uninterruptible`/`interruptUnsafe`/
  `addObserver`/`isDoneUnsafe`/`Effect.never` clusters are evidence the fiber
  model is being fought. In the UI: a renderer that compensates for the data
  model (`Date.now()`, synthetic ids, DOM existence checks, dedup).
- Error handling that should be defined out of existence: multi-level
  fallbacks, catch sites that re-classify, `Effect.ignore` / `catch {}` over a
  failure the design could make impossible, warnings for conditions a shape
  could refuse.
- Two representations of one fact (a derived predicate, a view field, a
  setting and a computed default, a message type and a row that answer the
  same question). Count them; name which survives.
- Comments substituting for design: a doc comment that explains a hand-off
  protocol, a sequence of states or why a port exists is a sign the
  structure, not the prose, is wrong. Report comment-line share for the worst
  files (`grep -cE '^\s*(/\*|\*|//)'` vs total).
- Change amplification: name one plausible change (a fourth host, a new tool
  plugin, a new provider, a new row kind the UI shows, a new setting) and
  count the files it touches.

## Output format (write to the file named in your task, then return a summary)

Start with a short "Numbers" section: lines per subdirectory, the five
largest files, comment share of the five worst files ≥ 200 lines, counts of
the primitives above.

For each finding (aim for the 5–12 strongest; thin ones batched or dropped):

1. **Title** (what is wrong, in plain words) and the red flag(s).
2. **Evidence**: `path:line` citations, consumer counts, a quoted line or two.
3. **The design decision behind it**: the root question the code answers in
   several places or in the wrong place.
4. **The better design**: what the module boundary should be, what one
   structure replaces the several, what is DELETED (list symbols with
   counts), what the callers write against afterwards. Prefer: Effect
   primitives over hand-rolled; one owner per fact; one transaction over a
   sequence; a type over a sentinel; refusing a case at a boundary over
   handling it everywhere.
5. **What we give up** (honest: a capability, a message, a special case) and
   risk.
6. **Change amplification before/after** for one named change.
7. **Depends on**: which root (R1–R10) or round-1 finding must land first, or
   "none": the finding can land alone.

Then **"Good modules in this area"**: deep modules worth copying.

Then **"Already settled, left alone"**: things you considered and rejected
because a dated note, a refuted candidate or an AGENTS.md rule justifies
them, with the citation.

Be honest. A module that is fine is reported as fine. Do not pad. Return a
summary of at most 25 lines: each finding's title, flag, and whether it
depends on a root.

## Areas

| Area | Report              | Scope                                                                                                                                                                                                                                                                                                                           |
| ---- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G    | `G-app-controllers.md` | `packages/texra/src/controllers/` (except `server/`'s service lifetime, wire and windows: found), `hosts/`, `agent/`, `platform/`, `model/`, `common/`, `utils/`, `telemetry/`, `housekeeping/`. Key questions: how a host action reaches a run; how approvals and diffs are presented; the settings and onboarding controllers. |
| H    | `H-app-tools.md`       | `packages/texra/src/tools/` except `latex/` and `documents/`: lean, github, zotero, arxiv, support, and the plugin registrations. Key questions: how a tool plugin owns a process, a poll, a cache; how many ways a plugin reaches the host.                                                                                     |
| I    | `I-latex-documents.md` | `packages/texra/src/latex/`, `replacement/`, `tools/latex/`, `tools/documents/`, `agent/output/`. Key questions: the document task recipe; file targets and accepted-file flows; the replacement rule tables; latexdiff and the toolchain constants.                                                                              |
| J    | `J-ui-kit.md`          | `packages/texra/src/ui/` and `packages/texra/src/shared/`. Key questions: message types versus rows (two representations); renderers compensating for data; formatter tables; the progress view's session transport and composer; the settings-view message catalog.                                                              |
| K    | `K-cli.md`             | `packages/cli/src/` except what F and the CLI-service note found (chat's run registry, approvals, host requests, exit code, NDJSON drainer, service lifetime). Key questions: the TUI's state stores and panes; the transcript ring; status bar; command definitions and `defineCliCommand`; runtime init.                        |
| M    | `M-harness-tools.md`   | `packages/harness/src/tools/`, `plugins.ts`, `skills/`, `platform/`, `utils/`, `transcript/`, `logger/`, `common/`, `controllers/`, `host.ts`, `node.ts`, `index.ts`. Key questions: the built-in tools' shared state; `toolAvailability`; executions listing; the platform layer's ports; `utils/` as a conjoined directory.  |
| N    | `N-vscode-desktop.md`  | `packages/extension/src/` and `packages/desktop/src/` (main and renderer), and `packages/trace-viewer/`. Key questions: a host request's path from a webview to the session; the PTY host; the desktop renderer's editor pane; `commands.ts`; the settings-view frontend state.                                                 |
| O    | `O-llm-providers.md`   | `packages/llm/src/` except D's model-call path (retry loop, drivers, verdict, background, `ModelRetryGate`, binding/`ScopedRef`, `sharedAttempt`, helper model, `ModelInvoker`): providers, `api/*Interactions`, `modelRoute`, `uploadCache`, the oauth providers and login flows, the model catalog.                           |
