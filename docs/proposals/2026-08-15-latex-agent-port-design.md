# Narrow `latex → agent` port: the three remaining coupling sites

Status: proposal (design for #10133)
Date: 2026-08-15

## Framing

#10118 removed three of the six `latex → agent` import sites by relocating
pure, dependency-free utilities to their actual homes. The three that remain
are different in kind: latex diff/media code genuinely needs to read agent
execution and trace data. A mechanical move would hide the coupling instead of
removing it, so this document designs a narrow port for each site — latex owns
the interface, agent owns the implementation, and the host composition roots
wire the two implementations that latex code cannot construct itself.

The success condition is architectural, not cosmetic: after the migration no
file under `src/latex/**` imports `@agent/*` (static, `import type`, or
dynamic), so the `latex → agent` edge can be deleted from
`config/ratchets/architecture-edges-baseline.json`. Behavior is unchanged; the
three ports below are typed structural slices of the agent surface latex
already uses.

## Coupling inventory

Verified at HEAD `9ad3fb167d` with
`grep -rn "from '@agent\|import('@agent" src/latex`. The remaining sites are
exactly the three the #10118 body scheduled:

| Site | File:line                                      | Import                                                                                                          | Kind          | What latex reads                                                                                    |
| ---- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------- | --------------------------------------------------------------------------------------------------- |
| 1    | `src/latex/LatexMediaManager.ts:8`             | `import type { AgentTrace } from '@agent/trace/AgentTrace'`                                                     | type-only     | `debug/info/warn/error` with an optional `{ data }` payload; used as the constructor logger (`:59`) |
| 2    | `src/latex/texraResponseTextProcessing.ts:1`   | `import type { ResponseTextProcessing } from '@agent/runtime/responseTextProcessing'`                           | type-only     | the policy object type exported at `:5`                                                             |
| 2b   | `src/latex/texraResponseTextProcessing.ts:11`  | `await import('@agent/runtime/textConnection')`                                                                 | dynamic value | `bestConnectionMethod(previous, next).connector`                                                    |
| 3    | `src/latex/latexdiff/outputDiscovery.ts:11-16` | `{ getExecutionStore, isAgentRunEntry, listExecutions, type AgentExecutionListingEntry } from '@agent/storage'` | value         | execution listing, agent-run narrowing, and `readMeta().streamId` for metadata auto-discovery       |

Inventory size: **3 files, 4 `latex → agent` import statements** (two
type-only, two value; one of the value imports is dynamic).

## Port shape

All three ports live in `src/latex/**`, so latex never imports agent to name
them. Agent imports the port types it implements through the existing
`agent → latex` edge (already a baseline value edge), and the hosts inject the
agent-owned implementations through `@agent/*` specifiers they already import —
the host deep-import baseline does not widen.

### P1 — `LatexTrace` (site 1)

Defined in `src/latex/LatexMediaManager.ts`, next to the existing
`MediaWorkspaceState` port. This is the logger slice `LatexMediaManager`
actually calls; it deliberately excludes stages, streams, tool cards, and the
other `AgentTrace` sugar.

```ts
export interface LatexLogOptions {
  readonly data?: unknown;
}

export interface LatexTrace {
  debug(message: string, options?: LatexLogOptions): void;
  info(message: string, options?: LatexLogOptions): void;
  warn(message: string, options?: LatexLogOptions): void;
  error(message: string, options?: LatexLogOptions): void;
}
```

`AgentTrace` already structurally satisfies this: its `debug/info/warn/error`
methods accept `LogOptions` with `data?: unknown` (`src/agent/trace/AgentTrace.ts`).
The only construction site, `src/agent/implementations/flows/reflection/runReflectionFlow.ts:145`,
keeps passing its `logger` unchanged.

### P2 — `ResponseTextProcessing` + `ResponseTextConnector` (site 2)

`ResponseTextProcessing` moves from
`src/agent/runtime/responseTextProcessing.ts:11` to
`src/latex/texraResponseTextProcessing.ts`. It becomes the latex-owned policy
contract; the agent runtime consumes it as a type and supplies only the
connector strategy. The dynamic `textConnection` import disappears behind an
injected `ResponseTextConnector`.

```ts
// src/latex/texraResponseTextProcessing.ts
import replacementEngine from '@replacement/engine';

export type ResponseTextPostProcessor = (text: string) => string;

export type ResponseTextConnector = (
  previous: string,
  next: string,
) => Promise<string>;

export interface ResponseTextProcessing {
  readonly normalizeResponseText: ResponseTextPostProcessor;
  readonly postProcessResponse: ResponseTextPostProcessor;
  readonly connectResponseText: ResponseTextConnector;
}

export function createTexraResponseTextProcessing(
  connectResponseText: ResponseTextConnector,
): ResponseTextProcessing {
  return Object.freeze({
    normalizeResponseText: (text: string): string => text.trim(),
    postProcessResponse: (text: string): string =>
      replacementEngine.applyAll(text),
    connectResponseText,
  });
}
```

Agent keeps the neutral default provider in
`src/agent/runtime/responseTextProcessing.ts`, but that file now imports the
type from latex and exports only `createNeutralResponseTextProcessing` (the
helper functions stay file-local). Agent also adds the connector
implementation next to the existing `bestConnectionMethod`:

```ts
// src/agent/runtime/textConnection.ts
import type { ResponseTextConnector } from '@latex/texraResponseTextProcessing';

export const agentResponseTextConnector: ResponseTextConnector = async (
  previous,
  next,
) => (await bestConnectionMethod(previous, next)).connector;
```

`agentResponseTextConnector` is re-exported from the existing `@agent/runtime`
barrel (`src/agent/runtime/index.ts`). All three hosts already import
`@agent/runtime`; they change their composition site from the old constant to
`createTexraResponseTextProcessing(agentResponseTextConnector)`.

### P3 — `LatexExecutionDiscoveryPort` (site 3)

Defined in a new `src/latex/latexdiff/executionDiscovery.ts`. This is the
narrowest slice that lets `outputDiscovery.ts` stop importing
`@agent/storage` while preserving its exact control flow: list agent runs,
then lazily read a matched run's stream id.

```ts
// src/latex/latexdiff/executionDiscovery.ts
import type { ExecutionId, StreamTabId } from '@shared/schemas';

export interface LatexAgentRunEntry {
  readonly id: ExecutionId;
  readonly timestamp: string;
  readonly agent: string;
  readonly model: string;
  readonly inputFiles: readonly string[];
}

export interface LatexExecutionDiscoveryPort {
  listAgentRuns(): Promise<readonly LatexAgentRunEntry[]>;
  readStreamId(executionId: ExecutionId): Promise<StreamTabId | undefined>;
}
```

Agent implements the port in `src/agent/storage/executionListing.ts` and
exports it through the existing `@agent/storage` barrel:

```ts
// src/agent/storage/executionListing.ts
import type {
  LatexAgentRunEntry,
  LatexExecutionDiscoveryPort,
} from '@latex/latexdiff/executionDiscovery';

export function createLatexExecutionDiscovery(): LatexExecutionDiscoveryPort {
  return {
    async listAgentRuns(): Promise<readonly LatexAgentRunEntry[]> {
      const executions = await listExecutions();
      return executions.filter(isAgentRunEntry).map((entry) => ({
        id: entry.id,
        timestamp: entry.timestamp,
        agent: entry.record.agent,
        model: entry.record.model,
        inputFiles: entry.record.inputFiles,
      }));
    },
    async readStreamId(executionId) {
      return (await getExecutionStore(executionId).readMeta())?.streamId;
    },
  };
}
```

The two-method shape matters. `readStreamId` is lazy because the current
`outputDiscovery.ts:248-255` loop only reads metadata for candidates that
already matched `agent/model/inputFile`; a listing entry carrying `streamId`
would force a metadata read for every agent run on every latexdiff discovery.

## Migration path per site

### Site 1 — `LatexMediaManager.ts`

1. Add `LatexLogOptions`/`LatexTrace` to `LatexMediaManager.ts` (adjacent to
   `MediaWorkspaceState`).
2. Replace `import type { AgentTrace } from '@agent/trace/AgentTrace'` with the
   inline `LatexTrace` definition; change the constructor parameter
   `logger: AgentTrace` to `logger: LatexTrace` (`:59`).
3. No caller changes: `runReflectionFlow.ts:145` still passes its `AgentTrace`;
   TypeScript verifies structural conformance.

### Site 2 — `texraResponseTextProcessing.ts`

1. Replace the two `@agent` imports with the local `ResponseTextProcessing`/
   `ResponseTextConnector` types and the factory above.
2. Update `src/agent/runtime/responseTextProcessing.ts` to import the type from
   `@latex/texraResponseTextProcessing`; update its consumers that name the
   type (`SessionHandle.ts:77`, `ModelFactory.ts:10`,
   `ModelHandler.ts:54`, `modelHandlerVscodeLm.ts:14`,
   `modelHandlerValidation.ts:14`) to import from latex.
3. Add `agentResponseTextConnector` to `textConnection.ts` and re-export it
   from `src/agent/runtime/index.ts`.
4. Update the three host composition roots to call
   `createTexraResponseTextProcessing(agentResponseTextConnector)`:
   `packages/extension/src/extension.ts:272`,
   `packages/desktop/src/main/index.ts:1210`,
   `packages/cli/src/runtime/transcriptSession.ts:47,110`.
   Each host already imports `@agent/runtime`, so no host-agent baseline row
   changes.

### Site 3 — `outputDiscovery.ts`

1. Add `src/latex/latexdiff/executionDiscovery.ts` with the two types above.
2. In `outputDiscovery.ts`, drop the `@agent/storage` import
   (`:11-16`), import `LatexExecutionDiscoveryPort` from
   `./executionDiscovery`, and change
   `discoverLatestExecutionOutputs` to take the port as its first parameter:

   ```ts
   export async function discoverLatestExecutionOutputs(
     discovery: LatexExecutionDiscoveryPort,
     query: { agent: string; model: string; inputFile: string },
     channel: string,
   ): Promise<{
     executionId: ExecutionId;
     rounds: RoundIndexed<OutputFileInfo>;
   } | null>;
   ```

   Replace `listExecutions()` with `discovery.listAgentRuns()`, the
   `isAgentRunEntry` predicate with the already-narrowed entry shape, and
   `(await getExecutionStore(candidate.id).readMeta())?.streamId` with
   `await discovery.readStreamId(candidate.id)`. The filtering, normalization,
   snapshot read, and run-dir fallback stay exactly where they are.

3. Add a required `readonly executionDiscovery: LatexExecutionDiscoveryPort`
   field to `RunLatexdiffForExecutionParams`
   (`src/latex/latexdiff/runLatexdiff.ts:60-76`) and pass it to
   `discoverLatestExecutionOutputs` at `:138-146`.
4. Add `createLatexExecutionDiscovery` to `src/agent/storage/executionListing.ts`
   and re-export it from `src/agent/storage/index.ts`.
5. Update the two host call sites to pass
   `executionDiscovery: createLatexExecutionDiscovery()`:
   `packages/extension/src/commands/latex/latexdiffCommands.ts:319-325` and
   `packages/desktop/src/main/desktopProgressFileActions.ts:213-227`. Both
   hosts already have `@agent/storage` in their deep-import baseline, so this
   adds no distinct specifier.
6. Update `src/test-kernel/latex/RunLatexdiff.vitest.ts` (add a fake
   `executionDiscovery` to `baseRequest`) and rewrite
   `src/test-kernel/latex/OutputDiscovery.vitest.ts` to inject an in-memory
   `LatexExecutionDiscoveryPort` fake instead of mocking `@agent/storage`.

## Architecture-edges ratchet update

After the migration, `collectSubsystemEdges()` in
`src/test-kernel/architecture/subsystemEdgeRatchet.vitest.ts` sees no
`latex → agent` import of any kind. The implementation PR therefore:

- Deletes the row
  `{ "from": "latex", "to": "agent", "kind": "value" }` from
  `config/ratchets/architecture-edges-baseline.json`. The list stays sorted
  and drops from 96 to 95 edges, above the test's `> 90` floor
  (`subsystemEdgeRatchet.vitest.ts:365`).
- Leaves `config/ratchets/host-agent-import-baseline.json` unchanged. Hosts
  use the existing `@agent/runtime` and `@agent/storage` specifiers for the
  two injected implementations; adding new import statements of an already
  baselined specifier does not widen the width count.
- Optionally adds a `src/latex` check to
  `src/test-kernel/architecture/dependencyDirection.vitest.ts`, mirroring the
  existing `src/shared` no-`@agent` guard. This is belt-and-braces: the
  subsystem edge ratchet already rejects a re-added `latex → agent` edge, but
  the dependency-direction test gives a second independent gate in the `npm test`
  path.

The `latex → agent` row is deleted rather than left as stale headroom for the
same reason `hostAgentDeepImportRatchet` rejects stale entries: a frozen row
with no live site can silently absorb a future re-introduction.

## Out of scope

- No new top-level subsystem (`src/ports`, `src/contracts`, etc.) and no new
  `@ports/*`/`@contracts/*` path alias. The ports live in `src/latex/**`, where
  their consumers already are.
- No move of the neutral `createNeutralResponseTextProcessing` out of
  `src/agent/runtime/responseTextProcessing.ts`; only the canonical type moves
  to latex.
- No change to the `latex → transcript` edge: `outputDiscovery.ts` still reads
  output files through `StreamSnapshotStore` (`@transcript`), because
  `@transcript` is not the agent runtime and the issue does not touch that edge.
- No change to `runLatexdiffForExecution`'s source priority
  (caller metadata → run-id scan → auto-discovery → workspace scan) or its
  fallback behavior.
- No changes to `nodeHost.ts`'s deliberate `platform → agent` edge, the
  test-kernel barrel items (#10131, #10132), or any other #10118 scheduled
  follow-up.
- No production code changes in this PR; this document is the design only.
- No Agent-SDK (`packages/agent`) public surface changes. The three ports are
  internal `src/latex` types; they do not become package exports.

## Alternatives considered

1. **Leave the direct imports (status quo).** Rejected: the two-way
   `agent ↔ latex` runtime dependency is the exact debt #10118 started
   retiring, and the architecture-edges baseline already records
   `latex → agent` as a value edge that keeps latex from being independently
   testable and embeddable.
2. **Another mechanical move.** Rejected in the issue: `LatexMediaManager`
   genuinely needs an agent trace, `texraResponseTextProcessing` needs the
   helper-model connector, and `outputDiscovery` needs the execution listing.
   Moving those files or copying their dependencies into latex would either
   invert a different edge or duplicate agent runtime machinery.
3. **A shared `src/ports`/`src/shared` port layer.** Rejected: AGENTS.md
   forbids new `@agent/*` imports under `src/shared`, a new top-level
   subsystem would add a cluster of new baseline edges and path-alias churn,
   and latex owning the ports it depends on is the smaller inversion with no
   new subsystem. The ports are only consumed by latex (and implemented by
   agent), so a neutral home buys nothing.
4. **Duplicate the `ResponseTextProcessing` type in latex instead of moving
   it.** Rejected: two structural copies of the same policy contract drift.
   Moving the canonical type to latex keeps one definition; agent's neutral
   default and model-handler consumers import it from latex through the
   already-baselined `agent → latex` edge.
5. **Fold `readStreamId` into the listing entries.** Rejected for the reason
   stated above: the current code reads metadata lazily per matched candidate,
   so a port that always carries `streamId` would perform extra reads for every
   listed run.
6. **A query-accepting `listAgentRuns(query)` port.** Rejected: matching and
   path normalization are latex orchestration behavior that should stay in
   `outputDiscovery.ts`; the agent adapter should stay a dumb projection of
   the existing `listExecutions`/`isAgentRunEntry` surface.

The narrow port wins because it is the smallest change that makes the
dependency direction honest: latex declares exactly the three slices it reads,
agent adapts surfaces it already owns, and the existing ratchets pin the new
boundary without widening any baseline.

## Verification plan

For the future implementation PR (not this one):

- `npx prettier --check` on all changed files.
- `npm run typecheck` (workspace + test-kernel + agent + cli + trace-viewer +
  desktop): structural conformance of `AgentTrace → LatexTrace`,
  `agentResponseTextConnector → ResponseTextConnector`, and the agent adapter
  to `LatexExecutionDiscoveryPort` is checked at compile time.
- `npm run lint`.
- `npx vitest run src/test-kernel/architecture`: confirms the updated
  `architecture-edges-baseline.json` is sorted, still `> 90` edges, and has no
  current `latex → agent` edge; the host deep-import ratchet stays green with
  unchanged baseline.
- `npx vitest run src/test-kernel/latex/RunLatexdiff.vitest.ts
src/test-kernel/latex/OutputDiscovery.vitest.ts
src/test-kernel/agent/modelHandlers/ResponseTextProcessing.vitest.ts
src/test-kernel/cli/RunChatSignalOwnership.vitest.ts`: the affected suites
  exercise the injected fakes and the factory form of the response-text policy.
- `npm test` full suite.
- `npm run check:dead-code-ratchet`: the moved type leaves no dead export in
  `src/agent/runtime/responseTextProcessing.ts`.

Once implemented, the port is pinned by (a) the subsystem edge ratchet with the
`latex → agent` row removed, (b) the unchanged host-agent deep-import ratchet
proving the host wiring uses only existing specifiers, and (c) the
dependency-direction test if the optional `src/latex` guard is added.

## Open question

- Should `RunLatexdiffForExecutionParams.executionDiscovery` be required or
  optional-with-explicit-skip? This design makes it required so a caller cannot
  silently lose metadata auto-discovery; if a legitimate host call site with no
  access to `@agent/storage` appears, relax it to optional with a documented
  "no auto-discovery" fallback at that time.
