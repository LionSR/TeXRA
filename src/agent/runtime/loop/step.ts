/**
 * The step: the one boundary where a run's tools, continuation and prompt
 * contributions change, and where the change is recorded (`2026-09-26-core-concepts.md`,
 * invariant 7).
 *
 * Each model request opens a step, and so does a conversation's park. It
 * applies the user's plugin switches, and the installed plugins enabled and
 * trusted from any host, to the live catalog (`@tools/liveTools`), pins its
 * current generations, and resolves from them
 * the tools the run is offered (`resolveStepTools`), the continuation for
 * its agent category, if any plugin on contributes one, and the prompt
 * contribution of each plugin on that makes one, with the process and
 * session services of the plugins it pinned: the only way a tool call or a
 * continuation reaches a plugin's services. The pin is held hand over hand: a
 * step's generation, and its plugins' layers, stay up until the run's next
 * step has pinned its own, so the calls a response makes run against the
 * tools its request offered, and a generation no step holds drains.
 *
 * The step renders the system text its requests send (`RenderSystem`).
 * When the offered set, the continuation, the prompt contributors or that
 * text differ from what the run last recorded, the step returns a
 * `tools.offered` row, preceded by the `context.blob` rows of the content it
 * names that the run has not stored yet, which the loop appends before the
 * request (or the park's decision) through the run's one ledger writer. A
 * resumed run's first step is held to what it recorded: it offers the recorded tools that are still in
 * the catalog as the same tool (the digest of its name and input schema, and
 * its plugin's id and revision), and names each one that is gone or changed.
 * A description is not part of a tool's identity: a changed one is recorded
 * as a new offered set, and a call made before it still runs. So is a
 * section whose text an update changed: nothing a request sends differs
 * from the latest record unrecorded.
 */
import { Context, Effect, Exit, Scope, SynchronizedRef } from 'effect';

import type { RuntimeToolRegistry } from '@agent/runtime/ToolServices';
import { MapToolRegistry } from '@agent/core/tools/ToolTypes';
import { withLogChannel } from '@logger/effectLog';
import type { PluginServices } from '@platform/processRuntime';
import {
  sameIdentity,
  type OfferedTool,
  type ToolDefinition,
} from '@shared/schemas';
import type { RunLedgerDraft, RunState } from '@shared/session/runStateFold';
import { sha256, type ContinuationEntry } from '@tools/catalogEntries';
import { LiveTools } from '@tools/liveTools';
import { switchedOffPlugins } from '@tools/plugins';
import type { PromptContribution } from '@tools/toolTable';
import { getDisabledToolIds } from '@utils/config/constants';

import { resolveStepTools } from '../agentToolResolution';
import { blobRows } from '../run/requestContext';
import { toolDefinitionsFor } from '../run/tools';
import { rowAggregate } from './rows';
import type { AgentRunShape } from '../run/AgentRun';

/** The tools one step offers. */
export interface StepTools {
  readonly definitions: readonly ToolDefinition[];
  /** The offered tools by name: dispatch runs nothing else. */
  readonly registry: RuntimeToolRegistry;
  /** Each offered tool's identity, in offer order. */
  readonly offered: readonly OfferedTool[];
  /** The pinned plugins' process and session services. */
  readonly services: Context.Context<PluginServices>;
}

/** The system text a step's requests send: the run's base text, and the
 *  prompt contributions the step pinned rendered for the tools it offers. */
export type RenderSystem = (
  prompt: ReadonlyMap<string, PromptContribution>,
  offered: readonly string[],
) => { readonly base: string | undefined; readonly added: string };

/** The run's current step, the scope that holds its pin, the tools it
 *  withheld for approval, its continuation, and its prompt contributions by
 *  plugin id, sorted. `holding` while only parks
 *  have opened steps in a resumed activation: its hold on the record is not
 *  spent yet. */
export interface OpenStep {
  readonly tools: StepTools;
  readonly scope: Scope.Closeable;
  readonly withheld: readonly string[];
  readonly continuation: ContinuationEntry | null;
  readonly prompt: ReadonlyMap<string, PromptContribution>;
  readonly holding: boolean;
}

/** A round-mode run's step: it offers no tools. */
const NO_TOOLS: StepTools = {
  definitions: [],
  registry: new MapToolRegistry(new Map()),
  offered: [],
  services: Context.empty() as Context.Context<PluginServices>,
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
 * Open the run's next step: apply the switches and pin the generation they
 * produce, as one step (`LiveTools.pinSwitched`), release the previous
 * step's pin, and resolve what it offers.
 * `recorded` holds a resumed activation's first step to it; `holding` says
 * the hold outlives this step (a park's). The rows
 * are what the loop appends before a request: the new offered set, when it
 * differs from `state`'s.
 */
const openStep = Effect.fn('Step.open')(function* (
  run: AgentRunShape,
  state: RunState,
  recorded: readonly OfferedTool[] | null,
  holding: boolean,
  render: RenderSystem,
) {
  const live = yield* LiveTools;
  const scope = yield* Scope.fork(run.scope);
  const step = yield* Effect.gen(function* () {
    const pinned = yield* live
      .pinSwitched(
        Effect.map(
          getDisabledToolIds(run.stores.globalState),
          switchedOffPlugins,
        ),
        { installed: true },
      )
      .pipe(Scope.provide(scope));
    const resolved = yield* resolveStepTools(pinned.generation, run.toolInputs);
    const held = recorded === null ? null : heldToRecord(resolved, recorded);
    const tools = held?.tools ?? resolved;
    const continuation =
      pinned.continuations.entries.get(run.config.agentCategory) ?? null;
    // Only the plugins this step uses hold services: a parked run keeps up
    // nothing it does not offer.
    const used = new Set([
      ...tools.offered.map(({ plugin }) => plugin),
      ...(continuation === null ? [] : [continuation.plugin]),
      ...pinned.sections.entries.keys(),
    ]);
    const services = Context.merge(
      yield* pinned.layersFor(used).pipe(Scope.provide(scope)),
      yield* run.session.runs
        .pinPlugins(
          pinned.generation.id,
          new Set(pinned.generation.owners.values()),
          used,
        )
        .pipe(Scope.provide(scope)),
    );
    return {
      tools: { ...tools, services },
      warnings: [
        ...pinned.warnings,
        ...resolved.warnings,
        ...(held?.notes ?? []),
      ],
      withheld: resolved.withheldForApproval,
      continuation,
      prompt: new Map(
        [...pinned.sections.entries].toSorted(
          ([a], [b]) => Number(a > b) - Number(a < b),
        ),
      ),
    };
  }).pipe(Effect.onError(() => Scope.close(scope, Exit.void)));
  const previous = yield* SynchronizedRef.getAndSet(run.steps, {
    tools: step.tools,
    scope,
    withheld: step.withheld,
    continuation: step.continuation,
    prompt: step.prompt,
    holding,
  });
  if (previous !== null) yield* Scope.close(previous.scope, Exit.void);
  const continuation = step.continuation?.plugin ?? null;
  const sections = [...step.prompt.keys()];
  const names = step.tools.definitions.map(({ name }) => name);
  const { base, added } = render(step.prompt, names);
  const system =
    base === undefined || added === '' ? base : `${base}\n${added}`;
  const address = system === undefined ? null : sha256(system);
  const toolsChanged = !sameSet(state.offeredTools, step.tools.offered);
  const changed =
    toolsChanged ||
    state.offeredContinuation !== continuation ||
    state.offeredSystem !== address ||
    sections.join('\0') !== state.offeredSections.join('\0');
  // What is withheld can change while the offered set does not (a plugin
  // switched on whose tools all need approval): reported on its own.
  const withheldChanged =
    step.withheld.length > 0 &&
    step.withheld.join('\0') !== (previous?.withheld ?? []).join('\0');
  const warnings = [
    ...(toolsChanged ? step.warnings : []),
    ...(withheldChanged
      ? [
          `Not offering ${step.withheld.join(', ')}: these tools need approval, and this run can neither show an approval prompt nor auto-approve under its approval policy. Use the yolo approval policy to allow them.`,
        ]
      : []),
  ];
  // Reported where the change is recorded, not at every step.
  for (const message of warnings) {
    yield* Effect.logWarning(message).pipe(withLogChannel('Step'));
    run.logger.warn(message);
  }
  if (withheldChanged)
    run.onApprovalPolicyDenial?.({
      kind: 'withheldTools',
      tools: step.withheld,
    });
  return {
    tools: step.tools,
    continuation: step.continuation?.continuation ?? null,
    prompt: step.prompt,
    system,
    // The content the set names is stored before the row that names it.
    rows: changed
      ? [
          // The base text is what a snapshot names.
          ...blobRows(run.runId, state, [
            ...(base === undefined ? [] : [base]),
            ...(system === undefined ? [] : [system]),
            ...toolDefinitionsFor(step.tools.definitions),
          ]),
          {
            type: 'tools.offered',
            aggregateId: rowAggregate(run.runId),
            payload: {
              tools: step.tools.offered,
              continuation,
              sections,
              system: address,
            },
          } satisfies RunLedgerDraft,
        ]
      : [],
  };
});

/**
 * The step the loop's next action runs under. A request opens a new step,
 * whose rows record its offered set when it changed. A dispatch runs the
 * calls against the step that offered them; for a response a resume found
 * pending, against a step pinned for the dispatch and held to the record,
 * which records nothing. A call to a tool whose identity changed or that
 * left since it was offered is stale: it settles as `tool_unavailable`,
 * like a name the run was never offered, and the step names the tool. A
 * park opens a step for its continuation, recorded like a request's. The
 * first request or dispatch step a resumed activation opens is held to the
 * record, and so is every park before it, which leaves the hold unspent. A
 * round-mode run offers no tools, and its rounds are its own continuation.
 */
export const stepFor = Effect.fn('Step.for')(function* (
  run: AgentRunShape,
  state: RunState,
  roundMode: boolean,
  kind: 'request' | 'dispatch' | 'park',
  render: RenderSystem,
) {
  if (roundMode)
    return {
      tools: NO_TOOLS,
      continuation: null,
      prompt: new Map(),
      system: undefined,
      rows: [],
    };
  const open = yield* SynchronizedRef.get(run.steps);
  if (open !== null && kind === 'dispatch')
    return {
      tools: open.tools,
      continuation: open.continuation?.continuation ?? null,
      prompt: open.prompt,
      system: undefined,
      rows: [],
    };
  const held = open === null || open.holding;
  const step = yield* openStep(
    run,
    state,
    held ? state.offeredTools : null,
    held && kind === 'park',
    render,
  );
  return kind === 'dispatch' ? { ...step, rows: [] } : step;
});

/** What `run`'s current step offers: the most a child it launches now may
 *  be offered. */
export const offeredBy = (run: Pick<AgentRunShape, 'steps'>) =>
  Effect.map(
    SynchronizedRef.get(run.steps),
    (open) => open?.tools.offered ?? [],
  );
