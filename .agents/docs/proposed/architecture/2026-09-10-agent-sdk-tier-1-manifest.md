# Agent SDK: the Tier-1 public manifest

Status: proposed

> **What this is.** The standalone Tier-1 manifest that
> [`2026-09-05-agent-sdk-architecture.md`](./2026-09-05-agent-sdk-architecture.md)
> §4 names as a deliverable — "The Tier-1 manifest names exact exports and
> actual consumers" — but never broke out as a file. The
> [2026-09-09 readiness pass](../../archived/simplification/2026-09-09-agent-sdk-readiness-reverify.md)
> §3b flagged that omission as "the one concrete, low-risk artifact still
> missing," to be extracted if the routine were ever asked to act. It was, on
> 2026-09-10; this is that extraction.
>
> First enumerated by direct inspection at `cf88d2d`; **re-enumerated
> 2026-09-15 at `697663eff1`**, after the one-run-model rename (S1, #12222)
> and the completed Effect-4 cutover (PocketFlow engine deleted in #12314, the
> `ModelHandler` god-base and `IModelHandler` port retired in #12320). The
> [2026-09-14 readiness pass](../../archived/simplification/2026-09-14-agent-sdk-readiness-reverify.md)
> §5.4 flagged that the first enumeration had drifted from the tree — stale
> `StreamView`/`ExecutionId` names, `IModelHandler` still treated as live —
> and called for exactly this re-enumeration. It remains a point-in-time
> inventory of the surface as **declared** today, not a proposal to change it:
> **no export is added, removed, or renamed by this document**. Where the
> declared surface has moved on from what the rest of this document once
> asserted, that is recorded as an open question in §7, not redefined here.
>
> **S0 amendment — landed.** Step S0 of the
> [one run model](../../implemented/architecture/2026-09-10-one-run-model.md) §6 dropped `StreamTabId` and
> `StreamTabIdSchema` from every entry here, and S1 (#12222) then deleted the
> type rather than aliasing it. The same S1 commit renamed the run id itself:
> `ExecutionId`/`ExecutionIdSchema` are now `RunId`/`RunIdSchema`
> (`src/shared/schemas/identifiers.ts:9-14`), declared on `/schemas` and
> `/effect`. Every count below is the surface after both.
>
> **2026-09-21 amendment — the surface flip.** The `/effect` subpath is
> retired and the root entry **is** the Effect surface: `Sessions`,
> `Session`, `Run`, the tagged errors and the tool-definition helpers. The
> Promise rendering (`runAgent`, `closeSession`, `AgentRun`, `RunAgentInput`,
> the composition cache) is deleted, per the rulings ledger's 2026-09-21
> supersession of R1 boundary kind (c). Every count below is the surface
> after the flip: three entries, 67 bindings, 63 distinct names.
>
> **2026-09-23 amendment — tools as data.** Under the owner decision
> recorded in the rulings ledger's amendment to the `defineTool` freeze
> (#12862), `defineTool` returns a plain tool object instead of a class to
> subclass. The type export `DefinedToolClass` is replaced one-for-one by
> `DefinedTool`, the object shape `defineTool` returns; the counts are
> unchanged.
>
> "Declared", not "published", throughout: `packages/agent` builds and bundles
> locally but is **not published to npm** (`AGENTS.md` §Layout), so every entry
> and export named below is a declared package surface, not a shipped release
> contract. Nothing here is externally committed, which is precisely what makes
> a later retirement decision cheap.
>
> This inventory does **not** on its own discharge the remaining boundary work
> `AGENTS.md` names ("the Tier-1 public manifest and shrinking the frozen
> deep-import lists"). It is the enumeration half, still `proposed`; the
> ratification of what Tier-1 keeps or seals, and the shrinking of the frozen
> lists, both remain open.

## 1. Method, and what was actually verified

Every name below was read out of the three entry modules under
`packages/agent/src/` and then resolved back to its defining module. Of the 65
re-exported bindings, 49 resolve to a direct `export` declaration in the named
module; the remaining 16 reach `src/shared/schemas/index.ts`, which is a barrel
of 60 `export *` lines, and each was resolved through it to a concrete
declaration — 15 distinct names across `opResults.ts`, `agent.ts`,
`agentConfig.ts`, `identifiers.ts`, `run.ts`, and `sessionEvent.ts`. Two
further names are declared locally in `node.ts`. Those two buckets are the §3
total: 65 + 2 = 67. **Nothing in §3 is unresolved.**

Verified by static resolution, cross-checked against the dead-export ratchet:
`npm run check:dead-code-ratchet` is green and records no `packages/agent`
export as production-dead, so no entry in §3 is a name nothing consumes.
`npm run typecheck:agent` (`pnpm --filter @texra-ai/agent build`, which runs
`validate-artifacts.mjs`) remains the authoritative check, and the §5
invariants are guarantees it enforces, not ones this document re-derives.

## 2. The three entries — the `/effect` correction is spent

`packages/agent/package.json` declares three entries:

| Entry                     | Subpath     | Shape                                                                                   |
| ------------------------- | ----------- | --------------------------------------------------------------------------------------- |
| `@texra-ai/agent`         | `.`         | The Effect services — where the decisions are stated — plus the tool-definition helpers |
| `@texra-ai/agent/schemas` | `./schemas` | Zod schemas and their inferred types                                                    |
| `@texra-ai/agent/node`    | `./node`    | The ready-made Node platform                                                            |

**The root entry is the surface.** Until 2026-09-21 the root was a Promise /
AsyncIterable rendering of the `/effect` services and owned four decisions of
its own — the process-global `composition` cache, the post-`shutdownRan`
refusal, the runtime-shutdown-handler registration, and the `RunFailure`
unwrapping. All four deleted with the rendering: on the one remaining surface
the scope owns each composition (`Sessions.layer`), `RunFailure` reaches the
embedder as the typed error it is, and there is no process-global cache to
hold. The two entries differed in lifetime ownership, not in run semantics;
now there is one entry and the scope is the lifetime.

**The `2026-09-05` §4 correction below is kept for the audit trail; its
conclusion is moot.** It argued `/effect` was Tier-1 because it was a declared
entry, the README called it "the surface," and the repository's only
consumer-shaped artifact imported it. All three facts were true; the 2026-09-21
flip resolved the tension the correction named by making the root entry that
surface, so a Tier-1 list seeded from `2026-09-05` §4 verbatim is now exactly
right: `packages/agent`, `/node`, and `/schemas`. The example imports
`{ Sessions }` from `@texra-ai/agent` and `{ nodePlatform }` from
`@texra-ai/agent/node`, installed from a packed tarball "exactly as a consumer
off the registry would get it."

## 3. Exact exports

**67 export bindings across the three entries; 63 distinct names** — 4 repeat
bindings across 4 names deliberately declared from more than one entry. 28
bindings are values, 39 are types.

Those 4 names in full, since each is a cross-entry commitment that has to be
changed in every entry at once:

| Name                 | Declared from    |
| -------------------- | ---------------- |
| `AgentFlowResult`    | root, `/schemas` |
| `ToolUseFlowResult`  | root, `/schemas` |
| `WorkflowFlowResult` | root, `/schemas` |
| `RunId`              | root, `/schemas` |

### 3.1 `@texra-ai/agent` — 34 (10 values, 24 types)

| Name                     | Kind  | Defined in                            |
| ------------------------ | ----- | ------------------------------------- |
| `Sessions`               | value | `./effect/sessions.js`                |
| `AgentNotFound`          | value | `./effect/errors.js`                  |
| `PlatformConflict`       | value | `./effect/errors.js`                  |
| `RunFailure`             | value | `./effect/errors.js`                  |
| `ToolsRefused`           | value | `./effect/errors.js`                  |
| `DatabaseOpenFailed`     | value | `@shared/session/database`            |
| `DatabaseReadFailed`     | value | `@shared/session/database`            |
| `aggregateId`            | value | `@shared/schemas` → `sessionEvent.ts` |
| `MapToolRegistry`        | value | `@agent/core/tools/ToolTypes`         |
| `defineTool`             | value | `@tools/core/definition`              |
| `AgentPlatform`          | type  | `./effect/runtime.js`                 |
| `Session`                | type  | `./effect/sessions.js`                |
| `Run`                    | type  | `./effect/sessions.js`                |
| `StartInput`             | type  | `./effect/sessions.js`                |
| `SessionView`            | type  | `./effect/sessions.js`                |
| `RunView`                | type  | `./effect/sessions.js`                |
| `TranscriptView`         | type  | `./effect/sessions.js`                |
| `LaunchError`            | type  | `./effect/errors.js`                  |
| `SessionOpenError`       | type  | `@shared/session/database`            |
| `AgentEvent`             | type  | `@agent/trace`                        |
| `AgentFlowResult`        | type  | `@agent/runtime/AgentFlowResult`      |
| `ToolUseFlowResult`      | type  | `@agent/runtime/AgentFlowResult`      |
| `WorkflowFlowResult`     | type  | `@agent/runtime/AgentFlowResult`      |
| `ITool`                  | type  | `@agent/core/tools/ToolTypes`         |
| `IToolRegistry`          | type  | `@agent/core/tools/ToolTypes`         |
| `ToolHost`               | type  | `@agent/core/tools/ToolTypes`         |
| `DefinedTool`            | type  | `@tools/core/definition`              |
| `AggregateId`            | type  | `@shared/schemas` → `sessionEvent.ts` |
| `TranscriptSubscription` | type  | `@shared/schemas` → `sessionEvent.ts` |
| `RunId`                  | type  | `@shared/schemas` → `identifiers.ts`  |
| `SessionCloseReport`     | type  | `@shared/schemas` → `opResults.ts`    |
| `RequestError`           | type  | `@shared/session/requestErrors`       |
| `Outcome`                | type  | `@shared/session/runtimeRequest`      |
| `RuntimeRequest`         | type  | `@shared/session/runtimeRequest`      |

### 3.2 `@texra-ai/agent/schemas` — 31 (17 values, 14 types)

| Name                         | Kind  | Defined in                              |
| ---------------------------- | ----- | --------------------------------------- |
| `AgentConfigSchema`          | value | `@agent/core/definition/AgentConfig`    |
| `ToolUseAgentConfigSchema`   | value | `@agent/core/definition/AgentConfig`    |
| `WorkflowAgentConfigSchema`  | value | `@agent/core/definition/AgentConfig`    |
| `AgentDefinitionSchema`      | value | `@agent/core/definition/AgentDataclass` |
| `AgentPromptSchema`          | value | `@agent/core/definition/AgentDataclass` |
| `AgentSettingSchema`         | value | `@agent/core/definition/AgentDataclass` |
| `AgentToolUseSettingSchema`  | value | `@agent/core/definition/AgentDataclass` |
| `AgentWorkflowSettingSchema` | value | `@agent/core/definition/AgentDataclass` |
| `ToolUseFlowResultSchema`    | value | `@agent/runtime/AgentFlowResult`        |
| `WorkflowFlowResultSchema`   | value | `@agent/runtime/AgentFlowResult`        |
| `AgentCategory`              | value | `@shared/schemas` → `agent.ts`          |
| `AgentCategorySchema`        | value | `@shared/schemas` → `agent.ts`          |
| `AgentNameSchema`            | value | `@shared/schemas` → `agent.ts`          |
| `AgentSourceSchema`          | value | `@shared/schemas` → `agent.ts`          |
| `RunIdSchema`                | value | `@shared/schemas` → `identifiers.ts`    |
| `RUN_OUTCOME`                | value | `@shared/schemas` → `run.ts`            |
| `RunOutcomeSchema`           | value | `@shared/schemas` → `run.ts`            |
| `AgentConfig`                | type  | `@agent/core/definition/AgentConfig`    |
| `AgentConfigPayload`         | type  | `@agent/core/definition/AgentConfig`    |
| `AgentDefinition`            | type  | `@agent/core/definition/AgentDataclass` |
| `AgentPrompt`                | type  | `@agent/core/definition/AgentDataclass` |
| `AgentSetting`               | type  | `@agent/core/definition/AgentDataclass` |
| `AgentToolUseSetting`        | type  | `@agent/core/definition/AgentDataclass` |
| `AgentWorkflowSetting`       | type  | `@agent/core/definition/AgentDataclass` |
| `AgentFlowResult`            | type  | `@agent/runtime/AgentFlowResult`        |
| `ToolUseFlowResult`          | type  | `@agent/runtime/AgentFlowResult`        |
| `WorkflowFlowResult`         | type  | `@agent/runtime/AgentFlowResult`        |
| `AgentConfigInput`           | type  | `@shared/schemas` → `agentConfig.ts`    |
| `AgentSource`                | type  | `@shared/schemas` → `agent.ts`          |
| `RunId`                      | type  | `@shared/schemas` → `identifiers.ts`    |
| `RunOutcome`                 | type  | `@shared/schemas` → `run.ts`            |

### 3.3 `@texra-ai/agent/node` — 2 (1 value, 1 type)

| Name                  | Kind  | Defined in          |
| --------------------- | ----- | ------------------- |
| `nodePlatform`        | value | _(local)_ `node.ts` |
| `NodePlatformOptions` | type  | _(local)_ `node.ts` |

## 4. Actual consumers

The honest count, and the reason publication stays gated:

- **External consumers: none.** npm publication is deliberately held until a
  named external consumer exists. The manifest therefore describes a surface
  with no installed base — which is exactly when it is cheapest to fix.
- **In-repo consumer-shaped: one.** `packages/agent/example/effectSession.mjs`,
  installed from a packed tarball, exercising the root entry (`Sessions`,
  `session.start`, the tagged refusal) and `/node` (`nodePlatform`). It is the
  only code in the tree that imports the package by its package name.
- **The three hosts consume none of it.** `extension`, `desktop`, and `cli`
  reach shared core through the repo-root `@agent/*` path aliases, not through
  `@texra-ai/agent`. Their coupling is governed separately by
  `config/ratchets/host-agent-import-baseline.json`.
- **Coverage gap worth naming:** no artifact in the repository imports
  **`/schemas`** by package name. All 31 schema exports are declared but
  unexercised as a consumer would reach them. The example covers the root +
  `/node` only.

## 5. What already keeps this surface honest

These are enforced today by `packages/agent/scripts/validate-artifacts.mjs` at
build time. They are cited, not added — per `CLAUDE.md`, the open work is this
manifest, "not another lint rule":

- **No provider-SDK type leak, per entry.** Every declared entry's declaration
  graph is walked and rejected if it reaches `@anthropic-ai/sdk`,
  `@google/genai`, `@openrouter/sdk`, or `openai` — "an entry whose declaration
  graph reaches a provider SDK puts that provider's types back on the declared
  surface however narrow the entry looks." This is why `index.ts` sources
  `AgentFlowResult` from its own module rather than the `@agent/runtime`
  barrel.
- **No `vscode`, no extension-host paths** in any declaration.
- **No unresolved internal path alias** leaking into declarations.
- **No source or declaration maps** emitted; NodeNext relative specifiers
  must carry `.js`.

`host-agent-import-baseline.json`'s `agent` row (7 specifiers:
`@agent/core/definition/AgentConfig`, `@agent/core/definition/AgentDataclass`,
`@agent/core/tools/ToolTypes`, `@agent/index`, `@agent/runtime`,
`@agent/runtime/AgentFlowResult`, `@agent/trace`) is, by that file's own
semantics, "exactly the internal-coupling width a Tier-1 barrel must re-export
or seal." Those seven are the modules §3 draws from.

## 6. Result taxonomy — closed on 2026-09-04; the re-verification below is now superseded

Recorded as historical verification only; this document does **not** close it
and there is no audit transition here.

The readiness passes carried "result-taxonomy documentation" as an open item
through
[`-09-02` §5.6](../../archived/simplification/2026-09-02-agent-sdk-readiness-reverify.md)
("the single largest 'which result do I get?' clarification the surface
needs"). It was **closed by the
[`-09-04` pass §5](../../archived/simplification/2026-09-04-agent-sdk-readiness-reverify.md)**,
which records commit `733b8a4` landing the documentation on the SDK surface and
the commit message marking `agent-sdk-readiness:S6` complete. The
[`-09-09` pass](../../archived/simplification/2026-09-09-agent-sdk-readiness-reverify.md)
correctly no longer carries it.

The first enumeration re-verified at `cf88d2d` that `packages/agent/README.md`
§"Run results" documented exactly one result shape, `AgentFlowResult`, with
`run.result` terminal-only and the non-terminal `WAITING` state deliberately
not exported. That core still holds at `697663eff1` — the waiting shape is
`WaitingToolUseFlowResult`/`AgentRuntimeFlowResult`
(`src/agent/runtime/AgentFlowResult.ts:50-61`), exported from its module but
not from any package entry. The details have moved, though: the README now
discriminates on `output.category` rather than `category`, states cost as
`usage.totalCost` rather than `totalCostUsd`, and puts the per-file `diffs` on
the declared `workflow` output rather than an internal type. Whether the
result-shape contract as the README now writes it is the ratified intent is
recorded as §7.2.

## 7. What this manifest does not settle

Deliberately out of scope — each is design-gated and named by its owning doc,
not by this inventory. Two items the first enumeration carried here are now
**resolved by deletion** and recorded only for the audit trail:

- ~~**Whether `IModelHandler` can ever be a public export**~~ — moot. The port
  was deleted with the `ModelHandler` god-base in #12320 (the runtime lane L3
  cutover), with no re-export shim left behind; the provider-type-leak concern
  that made it a manifest-design note died with it.
- ~~**Whether `AgentFinalResult` joins the surface**~~ — moot. The type is
  deleted entirely (`src/agent/runtime/AgentFinalResult.ts` no longer exists;
  no production references remain).

The live open items:

1. **An interactive approval / `HostInteractions` channel.** The package
   attaches a fixed headless host and refuses approval-requiring tools; this is
   also what keeps the `agentCreator` subagent boundary correctly open.
2. **The result-shape contract as the README now writes it** (§6). The
   declared `AgentFlowResult` gained `usage.totalCost` and the workflow
   output's per-file `diffs` since the `-09-04` closure, and the discrimination
   moved to `output.category`. The surface changed without this manifest's
   intent being re-stated; ratification should confirm or trim it.
3. **The database failure plane on the root entry.** #12485 added
   `DatabaseOpenFailed`, `DatabaseReadFailed`, and the `SessionOpenError` union
   (all from `@shared/session/database`) to the Effect surface — the SQLite
   store's open/read failures now reach embedders typed. This manifest records
   them because they are declared; whether durable-storage internals belong on
   Tier-1 is a ratification question, not one this document answers.
4. **The `AgentPlatform extends Platform` roots coupling** (`runtime.ts:56`),
   which `2026-09-05` §4 proposes removing as consumers move to explicit
   sessions. Still live, still open.
5. ~~**Re-derivation under the Effect-4 re-platform**~~ — discharged. The
   cutover landed (#12314 deleted the PocketFlow engine, #12320 retired the
   model-handler hierarchy), and this 2026-09-15 re-enumeration **is** the
   after-picture the first enumeration said should be produced when it landed.
