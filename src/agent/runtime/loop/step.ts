/**
 * The step: the one boundary where a run's tools change, and where the
 * change is recorded (`2026-09-26-core-concepts.md`, invariant 7).
 *
 * Each model request opens a step. It applies the user's plugin switches to
 * the live catalog (`@tools/liveTools`), pins the catalog's current
 * generation, and resolves the tools the run is offered from it
 * (`resolveStepTools`). The pin is held hand over hand: a step's generation,
 * and its plugins' layers, stay up until the run's next step has pinned its
 * own, so the calls a response makes run against the tools its request
 * offered, and a generation no step holds drains.
 *
 * When the offered set differs from the one the run last recorded, the step
 * returns a `tools.offered` row, which the loop appends before the request
 * through the run's one ledger writer. A resumed run's first request step is
 * held to what it recorded: it offers the recorded tools that are still in
 * the catalog as the same tool (the digest of its name and input schema, and
 * its plugin's id and revision), and names each one that is gone or changed.
 * A description is not part of a tool's identity: a changed one is recorded
 * as a new offered set, and a call made before it still runs.
 */
import { Context, Effect, Exit, Scope, SynchronizedRef } from 'effect';

import type { RuntimeToolRegistry } from '@agent/runtime/ToolServices';
import { MapToolRegistry } from '@agent/core/tools/ToolTypes';
import { withLogChannel } from '@logger/effectLog';
import {
  sameIdentity,
  type OfferedTool,
  type RunId,
  type ToolDefinition,
} from '@shared/schemas';
import type { RunLedgerDraft, RunState } from '@shared/session/runStateFold';
import { LiveTools } from '@tools/liveTools';
import { switchedOffPlugins } from '@tools/plugins';
import { getDisabledToolIds } from '@utils/config/constants';

import { resolveStepTools } from '../agentToolResolution';
import { rowAggregate } from './rows';
import type { AgentRunShape } from '../run/AgentRun';

/** The tools one step offers. */
export interface StepTools {
  readonly definitions: readonly ToolDefinition[];
  /** The offered tools by name: dispatch runs nothing else. */
  readonly registry: RuntimeToolRegistry;
  /** Each offered tool's identity, in offer order. */
  readonly offered: readonly OfferedTool[];
  /** The services of the pinned generation's plugin layers. */
  readonly services: Context.Context<never>;
}

/** The run's current step and the scope that holds its pin. */
export interface OpenStep {
  readonly tools: StepTools;
  readonly scope: Scope.Closeable;
}

/** A round-mode run's step: it offers no tools. */
const NO_TOOLS: StepTools = {
  definitions: [],
  registry: new MapToolRegistry(new Map()),
  offered: [],
  services: Context.empty(),
};

/** Whether `b` is the set `a` records: the same tools, as the same
 *  definitions. A description change is a new set to record, though it
 *  leaves every tool's identity as it was. */
const sameSet = (
  a: readonly OfferedTool[] | null,
  b: readonly OfferedTool[],
): boolean =>
  a !== null &&
  a.length === b.length &&
  a.every(
    (tool, index) =>
      sameIdentity(tool, b[index]) && tool.shown === b[index].shown,
  );

/** The recorded tools a resumed step may still offer, and why the rest
 *  are not offered. */
function heldToRecord(
  resolved: Omit<StepTools, 'services'>,
  recorded: readonly OfferedTool[],
): { readonly tools: Omit<StepTools, 'services'>; readonly notes: string[] } {
  const current = new Map(resolved.offered.map((tool) => [tool.name, tool]));
  // The current entry, which may describe the tool anew.
  const kept = recorded.flatMap((tool) => {
    const now = current.get(tool.name);
    return now !== undefined && sameIdentity(now, tool) ? [now] : [];
  });
  const names = new Set(kept.map(({ name }) => name));
  const notes = recorded
    .filter(({ name }) => !names.has(name))
    .map(({ name }) =>
      current.has(name)
        ? `Tool "${name}" changed since this run was offered it; the resumed run does not offer it at this step.`
        : `Tool "${name}" was offered to this run but is no longer available; the resumed run continues without it.`,
    );
  const byName = new Map(resolved.definitions.map((d) => [d.name, d]));
  return {
    tools: {
      definitions: kept.flatMap(({ name }) => byName.get(name) ?? []),
      registry: new MapToolRegistry(
        new Map(
          kept.flatMap(({ name }) => {
            const tool = resolved.registry.get(name);
            return tool ? [[name, tool] as const] : [];
          }),
        ),
      ),
      offered: kept,
    },
    notes,
  };
}

/**
 * Open the run's next step: apply the switches, pin the current generation
 * (releasing the previous step's pin), and resolve what it offers.
 * `recorded` holds a resumed activation's first step to it. The rows
 * are what the loop appends before a request: the new offered set, when it
 * differs from `state`'s.
 */
const openStep = Effect.fn('Step.open')(function* (
  run: AgentRunShape,
  state: RunState,
  recorded: readonly OfferedTool[] | null,
) {
  const live = yield* LiveTools;
  yield* live.sync(
    switchedOffPlugins(yield* getDisabledToolIds(run.stores.globalState)),
  );
  const scope = yield* Scope.fork(run.scope);
  const step = yield* Effect.gen(function* () {
    const pinned = yield* live.registry.pin.pipe(Scope.provide(scope));
    const resolved = yield* resolveStepTools(pinned.generation, run.toolInputs);
    const held = recorded === null ? null : heldToRecord(resolved, recorded);
    return {
      tools: { ...(held?.tools ?? resolved), services: pinned.resources },
      warnings: [...resolved.warnings, ...(held?.notes ?? [])],
      withheld: resolved.withheldForApproval,
    };
  }).pipe(Effect.onError(() => Scope.close(scope, Exit.void)));
  const previous = yield* SynchronizedRef.getAndSet(run.steps, {
    tools: step.tools,
    scope,
  });
  if (previous !== null) yield* Scope.close(previous.scope, Exit.void);
  const changed = !sameSet(state.offeredTools, step.tools.offered);
  if (changed) {
    // Reported where the change is recorded, not at every step.
    for (const message of step.warnings) {
      yield* Effect.logWarning(message).pipe(withLogChannel('Step'));
      run.logger.warn(message);
    }
    if (step.withheld.length > 0)
      run.onApprovalPolicyDenial?.({
        kind: 'withheldTools',
        tools: step.withheld,
      });
  }
  return {
    tools: step.tools,
    rows: changed ? [offeredRow(run.runId, step.tools.offered)] : [],
  };
});

function offeredRow(
  runId: RunId,
  tools: readonly OfferedTool[],
): RunLedgerDraft {
  return {
    type: 'tools.offered',
    aggregateId: rowAggregate(runId),
    payload: { tools },
  };
}

/**
 * The step the loop's next action runs under. A request opens a new step,
 * whose rows record its offered set when it changed. A dispatch runs the
 * calls against the step that offered them; for a response a resume found
 * pending, against a step pinned for the dispatch and held to the record,
 * which records nothing. A call to a tool whose identity changed or that
 * left since it was offered is stale: it settles as `tool_unavailable`,
 * like a name the run was never offered, and the step names the tool. The
 * first step a resumed activation opens is held to the record. A round-mode
 * run offers no tools.
 */
export const stepFor = Effect.fn('Step.for')(function* (
  run: AgentRunShape,
  state: RunState,
  roundMode: boolean,
  request = true,
) {
  if (roundMode) return { tools: NO_TOOLS, rows: [] };
  const open = yield* SynchronizedRef.get(run.steps);
  if (open !== null && !request) return { tools: open.tools, rows: [] };
  const step = yield* openStep(
    run,
    state,
    open === null ? state.offeredTools : null,
  );
  return request ? step : { tools: step.tools, rows: [] };
});

/** What `run`'s current step offers: the most a child it launches now may
 *  be offered. */
export const offeredBy = (run: Pick<AgentRunShape, 'steps'>) =>
  Effect.map(
    SynchronizedRef.get(run.steps),
    (open) => open?.tools.offered ?? [],
  );
