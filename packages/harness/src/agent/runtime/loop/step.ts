/**
 * The step: the one boundary where a run's tools, continuation and prompt
 * contributions change, and where the change is recorded (`2026-09-26-core-concepts.md`,
 * invariant 7).
 *
 * Each model request opens a step, and so does a conversation's park. It
 * applies the user's plugin switches, and the installed plugins enabled and
 * trusted from any host, to the live catalog (`@tools/liveTools`), pins its
 * current generations, and resolves from them
 * the tools the run is offered (`resolveStepTools`), the continuation of a
 * parked run, if any plugin on contributes one, and the prompt
 * contribution of each plugin on that makes one, with the process and
 * session services of the plugins it pinned: the only way a tool call or a
 * continuation reaches a plugin's services. The pin is held hand over hand: a
 * step's generation, and its plugins' layers, stay up until the run's next
 * step has pinned its own, so the calls a response makes run against the
 * tools its request offered, and a generation no step holds drains.
 *
 * The step renders the run's context: the sections its system text adds and
 * the delegation targets its delegation tools can launch, frozen at the
 * first step and after a compaction, a later change appended to the history
 * as a system message. A tool's description never carries live state, so a
 * new credential or agent does not rewrite the cached tools. When the offered set, the
 * continuation, the hooks or that context differ from what the run last
 * recorded, the step returns a `tools.offered` row, preceded by the
 * `context.blob` rows of the content it names that the run has not stored
 * yet and followed by that message, which the loop appends before the
 * request (or the park's decision) through the run's one run history writer. A
 * resumed run's first step is held to what it recorded: it offers the recorded tools that are still in
 * the catalog as the same tool (the digest of its name and input schema, and
 * its plugin's id and revision), and names each one that is gone or changed.
 * A description is not part of a tool's identity: a changed one is recorded
 * as a new offered set, and a call made before it still runs. So is a
 * section whose text an update changed: nothing a request sends differs
 * from the latest record unrecorded.
 */
import { Context, Effect, Exit, Scope, SynchronizedRef } from 'effect';
import { ModelProvider } from 'llm-zoo';
import { z } from 'zod';

import { stepInstructions } from '@agent/prompt/PromptBuilder';
import type { RuntimeToolRegistry } from '@agent/runtime/ToolServices';
import { MapToolRegistry } from '@agent/core/tools/ToolTypes';
import type { LoadablePlugin } from '@common/plugins/pluginTrust';
import { withLogChannel } from '@logger/effectLog';
import type { PluginContext } from '@platform/processRuntime';
import {
  isDocumentTaskConfig,
  AGENT_SKILLS_CONFIG_KEY,
  AgentSkillsEnabledSchema,
  sameIdentity,
  SKILL_CATALOG_MAX_SKILLS,
  type OfferedTool,
  type SkillCatalogEntry,
  type ToolDefinition,
} from '@shared/schemas';
import type { RunHistoryDraft, RunState } from '@shared/session/runStateFold';
import { loadRuntimeSkillCatalog } from '@skills/runtimeSkills';
import { toolDefinitionsFor, toolDigests } from '@tools/catalogEntries';
import { LiveTools } from '@tools/liveTools';
import { mcpServerOfToolName } from '@tools/mcp/mcpServer';
import { readDisabledTools } from '@tools/plugins';
import { readDelegationTargets } from '@tools/delegation/delegationAvailability';
import type { Continuation } from '@tools/toolTable';
import { sha256 } from '@utils/core/idHash';
import type { StepRoot } from '@utils/files/externalRoots';

import { declaredToolNames, resolveStepTools } from '../agentToolResolution';
import { liveToolGates } from '../requestPolicy';
import { goalGrant } from '../runApprovalQueue';
import { blobRows, contextAt, stored } from '../run/requestContext';
import { appendRow, rowAggregate } from './rows';
import { stepHooks, type StepHook } from './hooks';
import type { AgentRunShape } from '../run/AgentRun';

/** The tools one step offers. */
export interface StepTools {
  readonly definitions: readonly ToolDefinition[];
  /** The offered tools by name: dispatch runs nothing else. */
  readonly registry: RuntimeToolRegistry;
  /** Each offered tool's identity, in offer order. */
  readonly offered: readonly OfferedTool[];
  /** The pinned plugins' process and session services. */
  readonly services: PluginContext;
  /** The read-only skill directories its calls may read. */
  readonly stepRoots: readonly StepRoot[];
  /** The command hooks of the installed plugins it accepted, by plugin id:
   *  its calls, and the prompts and stops under it, run these. */
  readonly hooks: readonly StepHook[];
}

/** What a step's system text and skill roots are built from that the run
 *  holds, all recorded in its rows: its base text, the names of the skills
 *  its user activated, and whether it is a child. */
export interface RunSystem {
  readonly base: () => string | undefined;
  readonly activated: (state: RunState) => readonly string[];
  readonly isChild: () => boolean;
}

/** The run's current step, the scope that holds its pin, the tools it
 *  withheld for approval, and its continuation. `holding` while only parks
 *  have opened steps in a resumed activation: its hold on the record is not
 *  spent yet. */
export interface OpenStep {
  readonly tools: StepTools;
  readonly scope: Scope.Closeable;
  readonly withheld: readonly string[];
  readonly continuation: Continuation | null;
  /** The installed plugins it accepted and the plugins whose skills it
   *  draws on: what a skill the user activates meanwhile resolves against
   *  (`resolveActivations`). */
  readonly skills: {
    readonly plugins: readonly LoadablePlugin[];
    readonly contributors: ReadonlySet<string>;
  };
  readonly holding: boolean;
}

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
  resolved: Omit<StepTools, 'services' | 'stepRoots' | 'hooks'>,
  recorded: readonly OfferedTool[],
): {
  readonly tools: Omit<StepTools, 'services' | 'stepRoots' | 'hooks'>;
  readonly notes: string[];
} {
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
 * The offered tools with each that renders its description from the run's
 * declared tools (`ITool.describe`, the `script` tool's declarations)
 * described: at the step that freezes the system text, from the tools the
 * run declares (an MCP server's and the injected ones are left to
 * discovery); at any later step, as the run's last offered set recorded it,
 * so the text holds until a compaction opens the freeze again.
 */
function describedAtFreeze<
  T extends Omit<StepTools, 'services' | 'stepRoots' | 'hooks'>,
>(
  tools: T,
  state: RunState,
  declaration: AgentRunShape['toolInputs']['tools'],
): T {
  const describes = (name: string) =>
    tools.registry.get(name)?.describe !== undefined;
  if (!tools.definitions.some(({ name }) => describes(name))) return tools;
  const names = new Set(
    declaredToolNames(declaration).filter(
      (name) => mcpServerOfToolName(name) === undefined,
    ),
  );
  const declared = tools.definitions
    .filter(({ name }) => names.has(name) && !describes(name))
    .map((definition) => ({
      definition,
      scriptGlobal: tools.registry.get(definition.name)?.scriptGlobal,
    }));
  const recorded = (name: string) => {
    const shown =
      state.offeredContext === null
        ? undefined
        : state.offeredTools?.find((tool) => tool.name === name)?.shown;
    return shown === undefined
      ? undefined
      : stored(state, shown, z.object({ description: z.string() })).description;
  };
  const definitions = tools.definitions.map((definition) => {
    const describe = tools.registry.get(definition.name)?.describe;
    return describe === undefined
      ? definition
      : {
          ...definition,
          description: recorded(definition.name) ?? describe(declared),
        };
  });
  const shown = new Map(
    definitions.map((definition) => [
      definition.name,
      toolDigests({ definition }).shown,
    ]),
  );
  return {
    ...tools,
    definitions,
    offered: tools.offered.map((tool) => ({
      ...tool,
      shown: shown.get(tool.name) ?? tool.shown,
    })),
  };
}

/**
 * Open the run's next step: apply the switches and pin the generation they
 * produce, as one step (`LiveTools.pinSwitched`), release the previous
 * step's pin, and resolve what it offers.
 * `recorded` holds a resumed activation's first step to it, and
 * `recordedHooks` a resumed dispatch to the hooks its calls were offered
 * under; `holding` says the hold outlives this step (a park's). The rows
 * are what the loop appends before a request: the new offered set, when it
 * differs from `state`'s. */
const openStep = Effect.fn('Step.open')(function* (
  run: AgentRunShape,
  state: RunState,
  recorded: readonly OfferedTool[] | null,
  holding: boolean,
  runSystem: RunSystem,
  recordedHooks: readonly string[] | null = null,
) {
  const live = yield* LiveTools;
  const { roots } = run.session;
  const scope = yield* Scope.fork(run.scope);
  const step = yield* Effect.gen(function* () {
    // No switch or approval withholds a recipe's fixed tools; else read live.
    const recipe = isDocumentTaskConfig(run.config);
    const off = recipe
      ? Effect.succeed(new Set<string>())
      : readDisabledTools(run.stores.globalState);
    const pinned = yield* live
      .pinSwitched(off, { installed: true })
      .pipe(Scope.provide(scope));
    const resolved = yield* resolveStepTools(pinned.generation, {
      ...run.toolInputs,
      ...liveToolGates(run.session),
      ...(recipe && { approvalPromptsUnavailable: false }),
    });
    const held = recorded === null ? null : heldToRecord(resolved, recorded);
    const tools = describedAtFreeze(
      held?.tools ?? resolved,
      state,
      run.toolInputs.tools,
    );
    // The plugin on that continues a parked run, if any (the table rules
    // out two), and those that add a section to its text.
    const continuing =
      pinned.plugins.find(({ continuation }) => continuation !== undefined) ??
      null;
    const contributing = pinned.plugins.filter(
      ({ prompt }) => prompt !== undefined,
    );
    // Only the plugins this step uses hold services: a parked run keeps up
    // nothing it does not offer.
    const used = new Set([
      ...tools.offered.map(({ plugin }) => plugin),
      ...(continuing === null ? [] : [continuing.id]),
      ...contributing.map(({ id }) => id),
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
    // The skills: the built-in plugins on and the installed ones the step
    // accepted contribute, as it accepted them, so a plugin enabled or
    // updated since reaches this step's text. A step held to the record
    // lists what the record lists, whatever the toggle says now, as its
    // tools are; otherwise the settings toggle turns the listing off. A
    // skill the user activated is resolved either way. The skills a step
    // lists or its user activated are the ones its calls may read.
    const contributors = new Set([
      ...pinned.plugins.map(({ id }) => id),
      ...pinned.installed.keys(),
    ]);
    const skills = {
      plugins: [...pinned.installed.values()],
      contributors,
    };
    const names = runSystem.activated(state);
    const recordedSkills = recorded === null ? null : state.offeredSkills;
    const listing =
      recordedSkills === null
        ? AgentSkillsEnabledSchema.parse(
            roots.config.get(AGENT_SKILLS_CONFIG_KEY),
          )
        : recordedSkills.length > 0;
    const catalog =
      listing || names.length > 0
        ? yield* loadRuntimeSkillCatalog({
            workspacePath: roots.workspace,
            settings: roots,
            plugins: { loadable: skills.plugins, withheld: [] },
            named: [...names, ...(recordedSkills ?? [])],
          })
        : { catalog: [], named: [], issues: [] };
    const contributes = ({ plugin }: SkillCatalogEntry) =>
      plugin === null || contributors.has(plugin);
    const byName = new Map(
      catalog.named.filter(contributes).map((entry) => [entry.name, entry]),
    );
    // Those of core sources and of the plugins it draws on, bounded after
    // the filter, so a withdrawn plugin's skills never push a listed one out.
    const listed = !listing
      ? []
      : (recordedSkills?.flatMap((name) => byName.get(name) ?? []) ??
        catalog.catalog.filter(contributes).slice(0, SKILL_CATALOG_MAX_SKILLS));
    const activated = names.flatMap((name) => byName.get(name) ?? []);
    const hooks = stepHooks(pinned.installed, recordedHooks);
    for (const note of hooks.notes) run.logger.warn(note);
    return {
      tools: {
        ...tools,
        services,
        // Its catalog entries carry their directories canonical already.
        stepRoots: [...listed, ...activated].flatMap(({ name, directory }) =>
          directory === null
            ? []
            : [{ absolutePath: directory, label: `Skill ${name}` }],
        ),
        hooks: hooks.hooks,
      },
      hooks: hooks.identities,
      warnings: [
        ...pinned.warnings,
        ...resolved.warnings,
        ...(held?.notes ?? []),
        ...catalog.issues.map(
          ({ severity, message, path }) =>
            `Skill import ${severity}: ${message}${path ? ` (${path})` : ''}`,
        ),
      ],
      withheld: resolved.withheldForApproval,
      continuing,
      skills,
      listed,
      contributing: contributing.toSorted(
        (a, b) => Number(a.id > b.id) - Number(a.id < b.id),
      ),
    };
  }).pipe(Effect.onError(() => Scope.close(scope, Exit.void)));
  const { tools, listed } = step;
  const previous = yield* SynchronizedRef.getAndSet(run.steps, {
    tools,
    scope,
    withheld: step.withheld,
    continuation: step.continuing?.continuation ?? null,
    skills: step.skills,
    holding,
  });
  if (previous !== null) yield* Scope.close(previous.scope, Exit.void);
  const continuation = step.continuing?.id ?? null;
  // A goal grant ends with a step that has no continuation (plugin off).
  if (continuation === null)
    yield* run.session.approvals.change(run.runId, goalGrant([]));
  // The model-dependent text follows the step's model and settings.
  const model = yield* SynchronizedRef.get(run.model);
  const delegation = yield* readDelegationTargets(
    step.tools.definitions,
    run.toolInputs.stores,
    run.delegationAgentScope ?? undefined,
  );
  const context = {
    ...stepInstructions(step.contributing, listed, {
      offered: step.tools.definitions.map(({ name }) => name),
      isChild: runSystem.isChild(),
      isAnthropic: model.config.provider === ModelProvider.ANTHROPIC,
      config: roots.config,
    }),
    ...(delegation && { delegation }),
  };
  const base = runSystem.base();
  const { system, update } = contextAt(state, base, context);
  const toolsChanged = !sameSet(state.offeredTools, step.tools.offered);
  const skills = listed.map(({ name }) => name);
  const skillsChanged = skills.join('\0') !== state.offeredSkills.join('\0');
  const changed =
    toolsChanged ||
    skillsChanged ||
    state.offeredContinuation !== continuation ||
    state.offeredContext !== sha256(context) ||
    step.hooks.join('\0') !== state.offeredHooks.join('\0');
  // What is withheld can change while the offered set does not (a plugin
  // switched on whose tools all need approval): reported on its own.
  const withheldChanged =
    step.withheld.length > 0 &&
    step.withheld.join('\0') !== (previous?.withheld ?? []).join('\0');
  const warnings = [
    ...(toolsChanged || skillsChanged ? step.warnings : []),
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
    run.session.interactions.approvalDenied(
      { kind: 'withheldTools', tools: step.withheld },
      run.runId,
    );
  return {
    tools,
    continuation: step.continuing?.continuation ?? null,
    system,
    // The content the set names is stored before the row that names it.
    rows: changed
      ? [
          // The base text is what a snapshot names.
          ...blobRows(run.runId, state, [
            ...(base === undefined ? [] : [base]),
            ...(system === undefined ? [] : [system]),
            context,
            ...toolDefinitionsFor(step.tools.definitions),
          ]),
          {
            type: 'tools.offered',
            aggregateId: rowAggregate(run.runId),
            payload: {
              tools: step.tools.offered,
              continuation,
              skills,
              system: system === undefined ? null : sha256(system),
              context: sha256(context),
              hooks: step.hooks,
            },
          } satisfies RunHistoryDraft,
          ...(update === ''
            ? []
            : [appendRow(run.runId, [{ role: 'system', text: update }])]),
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
 * record, and so is every park before it, which leaves the hold unspent.
 */
export const stepFor = Effect.fn('Step.for')(function* (
  run: AgentRunShape,
  state: RunState,
  kind: 'request' | 'dispatch' | 'park',
  runSystem: RunSystem,
) {
  const open = yield* SynchronizedRef.get(run.steps);
  if (open !== null && kind === 'dispatch')
    return {
      tools: open.tools,
      continuation: open.continuation,
      system: undefined,
      rows: [],
    };
  const held = open === null || open.holding;
  const step = yield* openStep(
    run,
    state,
    held ? state.offeredTools : null,
    held && kind === 'park',
    runSystem,
    held && kind === 'dispatch' ? state.offeredHooks : null,
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

/**
 * The skills of `names` a user just activated that `run`'s current step
 * resolves: discovered by the same catalog read as its own, over the
 * plugins it accepted, and shipped by a core source or a plugin it draws
 * on. Before any step opens they are kept as named, and the first step
 * resolves them.
 */
export const resolveActivations = Effect.fn('Step.resolveActivations')(
  function* (run: AgentRunShape, names: readonly string[]) {
    const open = yield* SynchronizedRef.get(run.steps);
    if (open === null || names.length === 0) return [...names];
    const { roots } = run.session;
    const { named } = yield* loadRuntimeSkillCatalog({
      workspacePath: roots.workspace,
      settings: roots,
      plugins: { loadable: open.skills.plugins, withheld: [] },
      named: names,
    });
    const resolved = new Set(
      named
        .filter(
          ({ plugin }) =>
            plugin === null || open.skills.contributors.has(plugin),
        )
        .map(({ name }) => name),
    );
    return names.filter((name) => resolved.has(name));
  },
);
