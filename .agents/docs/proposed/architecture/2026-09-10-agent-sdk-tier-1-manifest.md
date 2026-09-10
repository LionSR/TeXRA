# Agent SDK: the Tier-1 public manifest

Status: proposed

> **What this is.** The standalone Tier-1 manifest that
> [`2026-09-05-agent-sdk-architecture.md`](./2026-09-05-agent-sdk-architecture.md)
> §4 names as a deliverable — "The Tier-1 manifest names exact exports and
> actual consumers" — but never broke out as a file. The
> [2026-09-09 readiness pass](../../implemented/simplification/2026-09-09-agent-sdk-readiness-reverify.md)
> §3b flagged that omission as "the one concrete, low-risk artifact still
> missing," to be extracted if the routine were ever asked to act. It was, on
> 2026-09-10; this is that extraction.
>
> Enumerated by direct inspection at `cf88d2d`. It is a point-in-time
> inventory of the surface as **declared** today, not a proposal to change it:
> **no export is added, removed, or renamed by this document.** The one
> substantive claim it makes is the `/effect` correction in §2.
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

Every name below was read out of the four entry modules under
`packages/agent/src/` and then resolved back to its defining module. Of the 75
re-exported bindings, 56 resolve to a direct `export` declaration in the named
module; the remaining 19 reach `src/shared/schemas/index.ts`, which is a barrel
of 60 `export *` lines, and each was resolved through it to a concrete
declaration — 16 distinct names across `opResults.ts`, `agent.ts`,
`identifiers.ts`, `stream.ts`, and `sessionEvent.ts`. Six further names are
declared locally in the entry files themselves (four in `index.ts`, two in
`node.ts`). **Nothing in §3 is unresolved.**

Verified by static resolution, not by compilation: this environment has no
installed `node_modules`, so `npm run typecheck:agent` (which is
`pnpm --filter @texra-ai/agent build`, and runs `validate-artifacts.mjs`) was
**not** run. That build remains the authoritative check, and the §5 invariants
are guarantees it enforces, not ones this document re-derives.

## 2. The four entries — and the `/effect` correction

`packages/agent/package.json` declares four entries:

| Entry                     | Subpath     | Shape                                                             |
| ------------------------- | ----------- | ----------------------------------------------------------------- |
| `@texra-ai/agent`         | `.`         | Promise / AsyncIterable rendering, plus its own process lifecycle |
| `@texra-ai/agent/schemas` | `./schemas` | Zod schemas and their inferred types                              |
| `@texra-ai/agent/effect`  | `./effect`  | The Effect services — where the decisions are stated              |
| `@texra-ai/agent/node`    | `./node`    | The ready-made Node platform                                      |

**The root entry is not purely a rendering.** Its own docstring says it "adds no
logic of its own," and that holds for the _run_ semantics — which level is a
run's first, when its drain ends, which failure wins are all stated once on
`/effect`. But `index.ts` does own decisions the scoped `/effect` entry
deliberately does not share, and a future API change needs them on the
ownership map:

- the process-global `composition` and its single hold, reused by every later
  `runAgent` on the same platform (`index.ts`, `agentServices`);
- the refusal of any run arriving after `lifecycle.shutdownRan` — stated in
  `index.ts` itself as "the Promise entry's own condition, since the Effect
  surface composes per scope";
- registration of the runtime shutdown handlers that close and flush the
  session, and release the hold;
- unwrapping `RunFailure` into its cause, so a Promise embedder catches what
  the launch path threw.

On `/effect` the scope owns each composition instead, so `Runtime.layer` may
compose the same process again. The two entries differ in lifetime ownership,
not in run semantics.

**Correction to `2026-09-05` §4.** That doc's "Package surface" paragraph reads
"Keep `packages/agent`, `@texra-ai/agent`, `/node` and the existing `/schemas`
surface" — it does not mention `/effect`. A Tier-1 list seeded from that
sentence verbatim would silently retire a live declared entry. Three
independent facts say `/effect` is Tier-1:

1. It is a declared entry in `package.json` `exports`.
2. `packages/agent/README.md` calls it "the surface," with the root entry as
   its Promise rendering holding "no logic of its own."
3. It is the entry the repository's **only consumer-shaped artifact** actually
   imports — `packages/agent/example/effectSession.mjs:16-17` imports
   `{ Runtime, Sessions }` from `@texra-ai/agent/effect` and `{ nodePlatform }`
   from `@texra-ai/agent/node`, installed from a packed tarball "exactly as a
   consumer off the registry would get it."

So the manifest is four entries, and `/effect` is not optional in it.

## 3. Exact exports

**81 export bindings across the four entries; 68 distinct names** — 13 repeat
bindings across 12 names deliberately declared from more than one entry. 30
bindings are values, 51 are types.

Those 12 names in full, since each is a cross-entry commitment that has to be
changed in every entry at once:

| Name                 | Declared from               |
| -------------------- | --------------------------- |
| `AgentFlowResult`    | root, `/schemas`, `/effect` |
| `ToolUseFlowResult`  | root, `/schemas`            |
| `WorkflowFlowResult` | root, `/schemas`            |
| `ExecutionId`        | `/schemas`, `/effect`       |
| `StreamTabId`        | `/schemas`, `/effect`       |
| `AgentPlatform`      | root, `/effect`             |
| `AgentEvent`         | root, `/effect`             |
| `ITool`              | root, `/effect`             |
| `SessionCloseReport` | root, `/effect`             |
| `SessionView`        | root, `/effect`             |
| `StreamView`         | root, `/effect`             |
| `TranscriptView`     | root, `/effect`             |

`AgentFlowResult` appears in three entries and so contributes two of the 13
repeats; the other eleven names contribute one each.

### 3.1 `@texra-ai/agent` — 19 (4 values, 15 types)

| Name                 | Kind  | Defined in                         |
| -------------------- | ----- | ---------------------------------- |
| `runAgent`           | value | _(local)_ `index.ts`               |
| `closeSession`       | value | _(local)_ `index.ts`               |
| `defineTool`         | value | `@tools/core/define`               |
| `MapToolRegistry`    | value | `@agent/core/tools/ToolTypes`      |
| `AgentRun`           | type  | _(local)_ `index.ts`               |
| `RunAgentInput`      | type  | _(local)_ `index.ts`               |
| `AgentPlatform`      | type  | `./effect/runtime.js`              |
| `AgentEvent`         | type  | `@agent/trace`                     |
| `AgentFlowResult`    | type  | `@agent/runtime/AgentFlowResult`   |
| `ToolUseFlowResult`  | type  | `@agent/runtime/AgentFlowResult`   |
| `WorkflowFlowResult` | type  | `@agent/runtime/AgentFlowResult`   |
| `SessionView`        | type  | `./effect/sessions.js`             |
| `StreamView`         | type  | `./effect/sessions.js`             |
| `TranscriptView`     | type  | `./effect/sessions.js`             |
| `ITool`              | type  | `@agent/core/tools/ToolTypes`      |
| `IToolRegistry`      | type  | `@agent/core/tools/ToolTypes`      |
| `ToolHost`           | type  | `@agent/core/tools/ToolTypes`      |
| `DefinedToolClass`   | type  | `@tools/core/define`               |
| `SessionCloseReport` | type  | `@shared/schemas` → `opResults.ts` |

### 3.2 `@texra-ai/agent/schemas` — 33 (18 values, 15 types)

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
| `ExecutionIdSchema`          | value | `@shared/schemas` → `identifiers.ts`    |
| `StreamTabIdSchema`          | value | `@shared/schemas` → `identifiers.ts`    |
| `RUN_OUTCOME`                | value | `@shared/schemas` → `stream.ts`         |
| `RunOutcomeSchema`           | value | `@shared/schemas` → `stream.ts`         |
| `AgentConfig`                | type  | `@agent/core/definition/AgentConfig`    |
| `AgentConfigInput`           | type  | `@agent/core/definition/AgentConfig`    |
| `AgentConfigPayload`         | type  | `@agent/core/definition/AgentConfig`    |
| `AgentDefinition`            | type  | `@agent/core/definition/AgentDataclass` |
| `AgentPrompt`                | type  | `@agent/core/definition/AgentDataclass` |
| `AgentSetting`               | type  | `@agent/core/definition/AgentDataclass` |
| `AgentToolUseSetting`        | type  | `@agent/core/definition/AgentDataclass` |
| `AgentWorkflowSetting`       | type  | `@agent/core/definition/AgentDataclass` |
| `AgentFlowResult`            | type  | `@agent/runtime/AgentFlowResult`        |
| `ToolUseFlowResult`          | type  | `@agent/runtime/AgentFlowResult`        |
| `WorkflowFlowResult`         | type  | `@agent/runtime/AgentFlowResult`        |
| `AgentSource`                | type  | `@shared/schemas` → `agent.ts`          |
| `ExecutionId`                | type  | `@shared/schemas` → `identifiers.ts`    |
| `StreamTabId`                | type  | `@shared/schemas` → `identifiers.ts`    |
| `RunOutcome`                 | type  | `@shared/schemas` → `stream.ts`         |

### 3.3 `@texra-ai/agent/effect` — 27 (7 values, 20 types)

| Name                     | Kind  | Defined in                            |
| ------------------------ | ----- | ------------------------------------- |
| `Runtime`                | value | `./effect/runtime.js`                 |
| `Sessions`               | value | `./effect/sessions.js`                |
| `AgentNotFound`          | value | `./effect/errors.js`                  |
| `PlatformConflict`       | value | `./effect/errors.js`                  |
| `RunFailure`             | value | `./effect/errors.js`                  |
| `ToolsRefused`           | value | `./effect/errors.js`                  |
| `aggregateId`            | value | `@shared/schemas` → `sessionEvent.ts` |
| `AgentRuntime`           | type  | `./effect/runtime.js`                 |
| `AgentPlatform`          | type  | `./effect/runtime.js`                 |
| `Session`                | type  | `./effect/sessions.js`                |
| `Run`                    | type  | `./effect/sessions.js`                |
| `StartInput`             | type  | `./effect/sessions.js`                |
| `SessionView`            | type  | `./effect/sessions.js`                |
| `StreamView`             | type  | `./effect/sessions.js`                |
| `TranscriptView`         | type  | `./effect/sessions.js`                |
| `LaunchError`            | type  | `./effect/errors.js`                  |
| `AgentEvent`             | type  | `@agent/trace`                        |
| `AgentFlowResult`        | type  | `@agent/runtime/AgentFlowResult`      |
| `ITool`                  | type  | `@agent/core/tools/ToolTypes`         |
| `AggregateId`            | type  | `@shared/schemas` → `sessionEvent.ts` |
| `TranscriptSubscription` | type  | `@shared/schemas` → `sessionEvent.ts` |
| `ExecutionId`            | type  | `@shared/schemas` → `identifiers.ts`  |
| `StreamTabId`            | type  | `@shared/schemas` → `identifiers.ts`  |
| `SessionCloseReport`     | type  | `@shared/schemas` → `opResults.ts`    |
| `RequestError`           | type  | `@shared/session/requestErrors`       |
| `Outcome`                | type  | `@shared/session/runtimeRequest`      |
| `RuntimeRequest`         | type  | `@shared/session/runtimeRequest`      |

### 3.4 `@texra-ai/agent/node` — 2 (1 value, 1 type)

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
  installed from a packed tarball, exercising `/effect` (`Runtime`, `Sessions`,
  `Session.start`, the tagged refusal) and `/node` (`nodePlatform`). It is the
  only code in the tree that imports the package by its package name.
- **The three hosts consume none of it.** `extension`, `desktop`, and `cli`
  reach shared core through the repo-root `@agent/*` path aliases, not through
  `@texra-ai/agent`. Their coupling is governed separately by
  `config/ratchets/host-agent-import-baseline.json`.
- **Coverage gap worth naming:** no artifact in the repository imports the
  **root** entry or **`/schemas`** by package name. `runAgent`, `AgentRun`,
  `defineTool`, and all 33 schema exports are declared but unexercised as a
  consumer would reach them. The example covers `/effect` + `/node` only.

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

## 6. Result taxonomy — closed on 2026-09-04, re-verified here

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
[`-09-09` pass](../../implemented/simplification/2026-09-09-agent-sdk-readiness-reverify.md)
correctly no longer carries it.

Re-verified at `cf88d2d` while enumerating §3: `packages/agent/README.md`
§"Run results" still documents exactly one result shape, `AgentFlowResult`,
discriminated on `category`; what each member adds; that `run.result` is
terminal-only and `WAITING` is a non-terminal internal state deliberately not
exported because the surface has no interactive channel to un-park it; and that
the normalized `cost` breakdown and per-file `diffs` stay on an internal type,
leaving the coarse `totalCostUsd` on the declared one. Still true, still the
prerequisite the item named for any future export of `AgentFinalResult`.

## 7. What this manifest does not settle

Deliberately out of scope — each is design-gated and named by its owning doc,
not by this inventory:

1. **Whether `IModelHandler` can ever be a public export.** It is a
   hand-maintained `Pick<ModelHandler<…>>`; its `M`/`T` parameters carry the
   provider-SDK types §5's guard rejects. A public port would need to be
   defined intrinsically first.
2. **Whether `AgentFinalResult` joins the surface.** It stays internal
   (`src/agent/runtime/AgentFinalResult.ts`), consumed by `storage/resultMeta.ts`,
   the workflow-script types, and the delegation strategies.
3. **An interactive approval / `HostInteractions` channel.** The package
   attaches a fixed headless host and refuses approval-requiring tools; this is
   also what keeps the `agentCreator` subagent boundary correctly open.
4. **The `AgentPlatform extends Platform` roots coupling**, which `2026-09-05`
   §4 proposes removing as consumers move to explicit sessions.
5. **Re-derivation under the Effect-4 re-platform.** The ratified direction
   ([`2026-09-04`](./2026-09-04-agent-runtime-on-effect.md),
   [`2026-09-06` delivery plan](./2026-09-06-effect-runtime-delivery-plan.md))
   retires PocketFlow and the `IModelHandler` port. This manifest is the
   before-picture that change should be diffed against, and should be
   re-enumerated when it lands.
