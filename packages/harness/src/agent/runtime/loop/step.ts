/**
 * The step: the one boundary where a run's tools and prompt contributions
 * change, and where the change is recorded.
 *
 * Each model request opens a step, and so does a conversation's park. It
 * applies the user's plugin switches, and the installed plugins enabled and
 * trusted from any host, to the live catalog (`ToolCatalog`), pins its
 * current generations, and resolves from them
 * the tools the run is offered (`resolveStepTools`) and the prompt
 * contribution of each plugin on that makes one, with the process and
 * session services of the plugins it pinned: the only way a tool call
 * reaches a plugin's services. The pin is held hand over hand: a
 * step's generation, and its plugins' layers, stay up until the run's next
 * step has pinned its own, so the calls a response makes run against the
 * tools its request offered, and a generation no step holds drains.
 *
 * The step renders the run's context: the sections its system text adds and
 * the delegation targets its delegation tools can launch, frozen at the
 * first step and after a compaction, a later change appended to the history
 * as a system message. A tool's description never carries live state, so a
 * new credential or agent does not rewrite the cached tools. When the offered set,
 * the hooks or that context differ from what the run last
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
import {
  Context,
  Effect,
  Exit,
  Record,
  Schema,
  Scope,
  ScopedRef,
  SynchronizedRef,
} from 'effect';
import { ModelProvider } from '@texra-ai/llm';
import stableStringify from 'safe-stable-stringify';

import { stepInstructions } from '@agent/prompt/PromptBuilder';
import { isTrustedScript } from '@agent/core/definition/RunRecord';
import { readDelegationTargets } from '@agent/runtime/delegation/delegationAvailability';
import type { LoadablePlugin } from '@common/plugins/pluginTrust';
import { withLogChannel } from '@logger/effectLog';
import type { PluginContext } from '@platform/processRuntime';
import { SessionRoots } from '@platform/rootedFs';
import { Settings } from '@shared/config/settings';
import {
  qualifyAggregateId,
  SKILL_CATALOG_MAX_SKILLS,
  type OfferedTool,
} from '@shared/schemas';
import type { RunHistoryDraft, RunState } from '@shared/session/runState';
import { mcpServerOfToolName } from '@shared/tools/toolDisplayName';
import {
  loadRuntimeSkillCatalog,
  type SkillCatalogEntry,
} from '@skills/runtimeSkills';
import { toolDefinitionsFor, toolDigests } from '@tools/catalogEntries';
import { readDisabledTools } from '@tools/plugins';
import type { SessionTools } from '@tools/sessionTools';
import { sha256 } from '@utils/core/idHash';
import type { StepRoot } from '@utils/files/externalRoots';

import {
  declaredToolNames,
  heldToRecord,
  resolveStepTools,
  type ResolvedTools,
} from '../agentToolResolution';
import { hostCapabilitiesOf, liveToolGates } from '../requests';
import { blobRows, contextAt, stored } from '../run/requestContext';
import { appendRow, SCRIPT_TOOL_NAME } from './rows';
import { stepHooks, type StepHooks } from './hooks';
import type { AgentRunShape } from '../run/AgentRun';
import { AGENT_SKILLS_ENABLED_SETTING } from '@shared/state/stateSettings';

/** The project's side of the tool catalog ({@link SessionTools}): its
 *  plugin layers and MCP servers, built in the session's scope and closed
 *  with it. A run holds what it declares here, and each step pins from it. */
export class ProjectTools extends Context.Service<ProjectTools, SessionTools>()(
  '@texra-ai/harness/session/ProjectTools',
) {}

/** The tools one step offers. */
export interface StepTools extends ResolvedTools {
  /** The pinned plugins' process and session services. */
  readonly services: PluginContext;
  /** The read-only skill directories its calls may read. */
  readonly stepRoots: readonly StepRoot[];
  /** The command hooks of the installed plugins it accepted, by plugin id:
   *  its calls, and the prompts and stops under it, run these. */
  readonly hooks: StepHooks;
  /** The modules its scripts may import, source by specifier. */
  readonly modules: { readonly [specifier: string]: string };
}

/** The run's current step, the scope that holds its pin, and the tools it
 *  withheld for approval. `holding` while only waits
 *  have opened steps in a resumed activation: its hold on the record is not
 *  spent yet. */
export interface OpenStep {
  readonly tools: StepTools;
  readonly scope: Scope.Closeable;
  readonly withheld: readonly string[];
  /** The installed plugins it accepted and the plugins whose skills it
   *  draws on: what a skill the user activates meanwhile resolves against
   *  (`resolveActivations`). */
  readonly skills: {
    readonly plugins: readonly LoadablePlugin[];
    readonly contributors: ReadonlySet<string>;
  };
  /** The recorded skills it left out: named at the step that first does. */
  readonly notOffered: readonly string[];
  readonly holding: boolean;
}

/** Whether `b` is the set `a` records: the same tools, as the same
 *  definitions, sent as recorded. A description change is a new set to
 *  record, though it leaves every tool's identity as it was. */
const sameSet = (
  a: readonly OfferedTool[] | null,
  b: readonly OfferedTool[],
): boolean => a !== null && stableStringify(a) === stableStringify(b);

/**
 * The offered tools with each that renders its description from the run's
 * declared tools and the modules its scripts may import (`ITool.describe`,
 * the `script` tool's declarations) described: at the step that freezes the
 * system text, from the tools the run declares (an MCP server's and the
 * injected ones are left to discovery); at any later step, as the run's last
 * offered set recorded it, so the text holds until a compaction opens the
 * freeze again.
 */
function describedAtFreeze<T extends ResolvedTools>(
  tools: T,
  state: RunState,
  declaration: AgentRunShape['toolInputs']['tools'],
  modules: readonly string[],
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
      : stored(state, shown, Schema.Struct({ description: Schema.String }))
          .description;
  };
  const definitions = tools.definitions.map((definition) => {
    const describe = tools.registry.get(definition.name)?.describe;
    return describe === undefined
      ? definition
      : {
          ...definition,
          description: recorded(definition.name) ?? describe(declared, modules),
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
 * Open the run's next step: read the switches and pin the tools they give
 * in the session's catalog (`SessionTools.pin`), release the previous
 * step's pin, and resolve what it offers.
 * `recorded` holds a resumed activation's first step to it, and
 * `recordedHooks` a resumed dispatch to the hooks its calls were offered
 * under; `holding` says the hold outlives this step (a wait's). Its
 * activated skills are the recorded ones, or until the opening commits,
 * the opening's. A change to what it offers is reported here, where
 * {@link stepFor} records it.
 */
const openStep = Effect.fn('Step.open')(function* (
  run: AgentRunShape,
  state: RunState,
  recorded: readonly OfferedTool[] | null,
  holding: boolean,
  recordedHooks: readonly string[] | null,
) {
  const roots = yield* SessionRoots;
  const scope = yield* Scope.fork(run.scope);
  const step = yield* Effect.gen(function* () {
    // A trusted script's tools are fixed; else read the switches live.
    const trusted = isTrustedScript(run.config);
    const off = trusted
      ? Effect.succeed(new Set<string>())
      : readDisabledTools(roots.globalState);
    const pinned = yield* (yield* ProjectTools)
      .pin(off, { installed: true, held: run.toolInputs.held })
      .pipe(Scope.provide(scope));
    const { policy, ...gates } = yield* liveToolGates(run);
    const resolved = yield* resolveStepTools(pinned.entries, {
      ...run.toolInputs,
      ...gates,
      hostCapabilities: yield* hostCapabilitiesOf(pinned, scope),
      ...(trusted && { approvalPromptsUnavailable: false }),
    });
    const held = recorded === null ? null : heldToRecord(resolved, recorded);
    // A step held to the record loads the modules it recorded, so a
    // resumed script runs the code it ran with.
    const imported =
      held === null
        ? pinned.modules
        : Record.map(state.offeredWith.modules, (at) =>
            stored(state, at, Schema.String),
          );
    const tools = describedAtFreeze(
      held?.tools ?? resolved,
      state,
      run.toolInputs.tools,
      Object.keys(imported),
    );
    // The plugins whose sections the step's system text renders.
    const contributing = pinned.plugins.filter(
      ({ prompt }) => prompt !== undefined,
    );
    // Only the plugins this step uses hold services: a parked run keeps up
    // nothing it does not offer.
    const used = new Set([
      ...tools.offered.map(({ plugin }) => plugin),
      ...contributing.map(({ id }) => id),
    ]);
    const services = yield* pinned.services(used).pipe(Scope.provide(scope));
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
    const skills = { plugins: [...pinned.installed.values()], contributors };
    const names =
      state.phase === null
        ? (run.opening?.activated ?? [])
        : (state.input.activated ?? []);
    const recordedSkills = recorded === null ? null : state.offeredWith.skills;
    const listing =
      recordedSkills === null
        ? Settings.getConfig(roots.config, AGENT_SKILLS_ENABLED_SETTING)
        : recordedSkills.length > 0;
    const catalog =
      listing || names.length > 0
        ? yield* loadRuntimeSkillCatalog({
            roots,
            plugins: { loadable: skills.plugins, withheld: [] },
            named: [...names, ...(recordedSkills ?? [])],
          })
        : { catalog: [], named: [], issues: [] };
    const contributes = ({ plugin }: SkillCatalogEntry) =>
      plugin === null || contributors.has(plugin);
    const byName = new Map(
      catalog.named.filter(contributes).map((entry) => [entry.name, entry]),
    );
    // A skill the run recorded (listed, or activated by its user) that this
    // step does not offer, its plugin withdrawn or the skill gone, is left
    // out and named, as a recorded tool is (`heldToRecord`).
    const notOffered = new Set<string>();
    const offered = (recordedNames: readonly string[]) =>
      recordedNames.flatMap((name) => {
        const entry = byName.get(name);
        if (entry === undefined) notOffered.add(name);
        return entry ?? [];
      });
    // Those of core sources and of the plugins it draws on, bounded after
    // the filter, so a withdrawn plugin's skills never push a listed one out.
    const listed = !listing
      ? []
      : recordedSkills === null
        ? catalog.catalog.filter(contributes).slice(0, SKILL_CATALOG_MAX_SKILLS)
        : offered(recordedSkills);
    const activated = offered(names);
    const hooks = stepHooks(run, pinned.installed, recordedHooks);
    const modules = tools.registry.has(SCRIPT_TOOL_NAME) ? imported : {};
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
        hooks,
        modules,
      },
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
      skills,
      listed,
      notOffered: [...notOffered],
      contributing: contributing.toSorted(
        (a, b) => Number(a.id > b.id) - Number(a.id < b.id),
      ),
    };
  }).pipe(Effect.onError(() => Scope.close(scope, Exit.void)));
  const { listed } = step;
  const tools: StepTools = step.tools;
  const previous = yield* SynchronizedRef.getAndSet(run.steps, {
    tools,
    scope,
    withheld: step.withheld,
    skills: step.skills,
    notOffered: step.notOffered,
    holding,
  });
  if (previous !== null) yield* Scope.close(previous.scope, Exit.void);
  const toolsChanged = !sameSet(state.offeredTools, tools.offered);
  const skills = listed.map(({ name }) => name);
  const skillsChanged =
    skills.join('\0') !== state.offeredWith.skills.join('\0');
  // What is withheld can change while the offered set does not (a plugin
  // switched on whose tools all need approval): reported on its own.
  const withheldChanged =
    step.withheld.length > 0 &&
    step.withheld.join('\0') !== (previous?.withheld ?? []).join('\0');
  const warnings = toolsChanged || skillsChanged ? [...step.warnings] : [];
  if (withheldChanged) {
    warnings.push(
      `Not offering ${step.withheld.join(', ')}: these tools need approval, and this run can neither show an approval prompt nor auto-approve under its approval policy. Use the yolo approval policy to allow them.`,
    );
  }
  // A skill is named once, at the first step that no longer offers it.
  for (const name of step.notOffered) {
    if (previous?.notOffered.includes(name) === true) continue;
    warnings.push(
      `Skill "${name}" was offered to this run but is no longer available; the run continues without it.`,
    );
  }
  // Reported where the change is recorded, not at every step.
  for (const message of warnings) {
    yield* Effect.logWarning(message).pipe(withLogChannel('Step'));
    run.logger.warn(message);
  }
  return {
    tools,
    listed,
    contributing: step.contributing,
    skills,
    changed: toolsChanged || skillsChanged,
  };
});

/**
 * The tools a dispatch runs its calls against: the step that offered them;
 * for a response a resume found pending, a step pinned for the dispatch and
 * held to the record, tools and hooks, which records nothing. A call to a
 * tool whose identity changed or that left since it was offered is stale:
 * its result is `tool_unavailable`, like a name the run was never offered,
 * and the step names the tool.
 */
export const dispatchTools = Effect.fn('Step.dispatch')(function* (
  run: AgentRunShape,
  state: RunState,
) {
  const open = yield* SynchronizedRef.get(run.steps);
  if (open !== null) return open.tools;
  const step = yield* openStep(
    run,
    state,
    state.offeredTools,
    false,
    state.offeredWith.hooks,
  );
  return step.tools;
});

/**
 * The step a request, or a wait (`waits`), opens: its tools, its system
 * text, and the rows that record its offered set when it differs from
 * `state`'s, which the loop appends before the request (or the wait's
 * decision). A wait's step is recorded like a request's, so a waiting run
 * holds only what its plugins offer now. The first request a resumed
 * activation opens is held to the record, and so is every wait before it,
 * which leaves the hold unspent. Its base text is the recorded one, or
 * until the opening commits, `openingSystem`.
 */
export const stepFor = Effect.fn('Step.for')(function* (
  run: AgentRunShape,
  state: RunState,
  waits: boolean,
  openingSystem?: string,
) {
  const open = yield* SynchronizedRef.get(run.steps);
  const held = open === null || open.holding;
  const step = yield* openStep(
    run,
    state,
    held ? state.offeredTools : null,
    held && waits,
    null,
  );
  const { tools, skills } = step;
  const roots = yield* SessionRoots;
  // The model-dependent text follows the step's model and settings.
  const model = yield* ScopedRef.get(run.model);
  const delegation = yield* readDelegationTargets(
    tools,
    roots,
    run.config.delegationAgentScope ?? undefined,
  );
  const context = {
    ...stepInstructions(step.contributing, step.listed, {
      offered: tools.definitions.map(({ name }) => name),
      isChild: run.entry.parent !== null,
      isAnthropic: model.config.provider === ModelProvider.ANTHROPIC,
      config: roots.config,
    }),
    ...(delegation && { delegation }),
  };
  const base =
    state.input.system === undefined
      ? openingSystem
      : stored(state, state.input.system, Schema.String);
  const { system, update } = contextAt(state, base, context);
  const modules = Record.map(tools.modules, sha256);
  const changed =
    step.changed ||
    stableStringify(modules) !== stableStringify(state.offeredWith.modules) ||
    state.offeredContext !== sha256(context) ||
    tools.hooks.identities.join('\0') !== state.offeredWith.hooks.join('\0');
  return {
    tools,
    system,
    // The content the set names is stored before the row that names it.
    rows: changed
      ? [
          // The base text is what the opening's `append` input names.
          ...blobRows(run.runId, state, [
            ...(base === undefined ? [] : [base]),
            ...(system === undefined ? [] : [system]),
            context,
            ...toolDefinitionsFor(tools.definitions),
            ...Object.values(tools.modules),
          ]),
          {
            type: 'tools.offered',
            aggregateId: qualifyAggregateId('run', run.runId),
            payload: {
              tools: tools.offered,
              skills,
              system: system === undefined ? null : sha256(system),
              context: sha256(context),
              hooks: tools.hooks.identities,
              modules,
            },
          } satisfies RunHistoryDraft,
          ...(update === ''
            ? []
            : [appendRow(run.runId, [{ role: 'system', text: update }])]),
        ]
      : [],
  };
});

/** What `run`'s current step offers: the tools a background script it
 *  launches now declares. */
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
    const roots = yield* SessionRoots;
    const { named } = yield* loadRuntimeSkillCatalog({
      roots,
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
