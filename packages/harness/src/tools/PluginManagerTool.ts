/**
 * The `plugin_manager` tool: a run's admin rights over what it loads. It
 * lists, installs, enables, disables and removes installed plugins through
 * the same operations the hosts' plugin commands call (`InstalledPlugins`),
 * so a plugin the agent enables is recorded, trusted and loaded exactly as
 * one a person enables. Enabling asks the person to trust the plugin as it
 * is now, showing the same review (`PluginReview`): that approval is the
 * trust record for the plugin's digest, so each version is asked about
 * once. A disable or a removal asks too; a listing or an install, which
 * records the plugin disabled and runs nothing of it, does not. Each change
 * reaches the run at its next step; a call already running keeps the
 * version its step pinned.
 */
// Node imports
import * as path from 'node:path';

// Third-party imports
import { Effect, Result, Schema } from 'effect';

// Local imports
import { InstalledPlugins } from '@common/plugins/installedPlugins';
import {
  describeProvides,
  NATIVE_ENTRY_FILE,
} from '@common/plugins/nativeEntry';
import {
  installedPluginId,
  type PluginListing,
  type PluginReview,
} from '@common/plugins/pluginTrust';
import {
  inRunSession,
  RunCall,
  type RunToolCall,
} from '@agent/runtime/RunCall';
import { refusalCopy } from '@shared/session/approvalDecision';
import { Approvals } from '@shared/session/runHistory';
import { ToolError, type RequestPayload, type RunId } from '@shared/schemas';
import { defineTool } from '@tools/core/definition';
import { nullishWithDefault } from '@tools/core/inputSchema';
import { nativeRevision } from '@tools/nativePlugins';
import { ToolRegistry, type ToolTable } from '@tools/toolTable';

const NameSchema = Schema.NonEmptyString.annotate({
  description: 'The installed plugin, by the name `list` answers.',
});

const PluginManagerInputSchema = Schema.Union([
  Schema.Struct({
    command: nullishWithDefault(
      Schema.Literal('list'),
      'list',
      'Answer every installed plugin. Default command.',
    ),
  }),
  Schema.Struct({
    command: Schema.Literal('install').annotate({
      description: 'Install a plugin, disabled.',
    }),
    source: Schema.NonEmptyString.annotate({
      description:
        'A plugin folder (relative to your working directory), a git URL, or github.com/<owner>/<repo>[@ref].',
    }),
  }),
  Schema.Struct({
    command: Schema.Literal('enable').annotate({
      description: 'Ask the person to trust a plugin, and load it.',
    }),
    name: NameSchema,
  }),
  Schema.Struct({
    command: Schema.Literal('disable').annotate({
      description: 'Stop loading a plugin; it stays installed.',
    }),
    name: NameSchema,
  }),
  Schema.Struct({
    command: Schema.Literal('remove').annotate({
      description: 'Forget a plugin and the trust given to it.',
    }),
    name: NameSchema,
  }),
]);
type PluginManagerInput = typeof PluginManagerInputSchema.Type;

/** Which revision of `plugin`'s native module the step's table (`table`)
 *  runs, and whether the one trusted now did not load, so the one before
 *  it stands in. */
const nativeState = (plugin: PluginListing, table: ToolTable): string[] => {
  if (plugin.native === null) return [];
  const id = installedPluginId(plugin.name);
  const inUse = table.natives.find(
    (native) => native.plugin.id === id,
  )?.revision;
  const trustedNow =
    plugin.enabled && plugin.trusted && plugin.trust !== undefined
      ? nativeRevision(plugin.native.file, plugin.trust.digest)
      : null;
  if (inUse === undefined)
    return trustedNow === null ? [] : ['  native module: not loaded'];
  return [
    `  native module: revision ${inUse.slice(0, 12)} in use`,
    ...(trustedNow === null || trustedNow === inUse
      ? []
      : [
          `  revision ${trustedNow.slice(0, 12)}, trusted now, did not load (your step's warnings say why); the one in use stays until the plugin is fixed or disabled, and only while this process runs`,
        ]),
  ];
};

/** One plugin as a listing answers it, with what the step's table runs of
 *  its native module. */
const listingLine = (plugin: PluginListing, table: ToolTable): string => {
  const state = [
    plugin.enabled ? 'enabled' : 'disabled',
    plugin.trusted ? 'trusted as it is' : 'not trusted as it is',
  ].join(', ');
  const carries = [
    `skills ${plugin.skillCount}`,
    `agents ${plugin.agentCount}`,
    `programs ${plugin.programs.join(', ') || 'none'}`,
    `MCP servers ${plugin.mcpServers.join(', ') || 'none'}`,
    `hooks ${plugin.hooks.length}`,
    `native module ${plugin.native === null ? 'none' : describeProvides(plugin.native.provides)}`,
  ].join('; ');
  return [
    `- ${plugin.name}${plugin.version ? ` ${plugin.version}` : ''} (${state}): ${carries}`,
    ...nativeState(plugin, table),
    ...(plugin.problem === undefined ? [] : [`  problem: ${plugin.problem}`]),
  ].join('\n');
};

/** What a plugin change asks a person: a command, or trusting a plugin. */
type PluginChangeRequest = Extract<
  RequestPayload,
  { kind: 'bash' | 'pluginTrust' }
>;

/**
 * Whether the person approves what `ask` asks for this call: the session's
 * policy first, as for any call (`Approvals.permission`), and then the
 * person, asked once. A refusal is the call's failure, with its reason.
 * Trusting the native module of `native` is a person's own answer,
 * whatever the policy and grants: the request opens as one a `PreToolUse`
 * hook asked about (`hook: 'ask'`), which the harness routes to a person
 * (`answeredBy: 'person'`) and no policy or grant answers. Where no person
 * can be asked, the call fails and says who can enable it.
 */
const approved = Effect.fn('plugin_manager.approved')(function* (
  call: RunToolCall,
  ask: (requestId: string, runId: RunId) => PluginChangeRequest,
  native: string | null = null,
) {
  const { runId } = call.run;
  const hook = native === null ? call.hook : 'ask';
  const answer = (yield* Approvals).permission(runId, 'call', hook);
  if (native !== null && answer !== 'ask')
    return yield* new ToolError(
      `Trusting the native module of ${native} takes a person's own answer, and this run cannot ask one${answer === 'allow' ? '' : `: ${answer.reason.replace(/\.$/, '')}`}. A person must enable ${native} themselves, outside this run.`,
    );
  if (answer === 'allow') return true;
  const decision =
    answer === 'ask'
      ? (yield* call.requests
          .open(ask(call.requests.nextId(), runId), { operation: 'call' })
          .pipe(Effect.updateService(RunCall, (open) => ({ ...open, hook }))))
          .decision
      : answer;
  if (decision.action === 'approve') return true;
  const copy = refusalCopy('Plugin change', decision);
  return yield* new ToolError(
    [copy.summary, copy.detail, copy.feedback].filter(Boolean).join(': '),
  );
});

/** A change asked as a command: a disable or a removal. */
const asCommand =
  (command: string) =>
  (requestId: string, runId: RunId): PluginChangeRequest => ({
    kind: 'bash',
    data: { requestId, command, runId },
  });

/** Trusting `review`'s plugin as it is now, asked as itself. */
const asTrust =
  (review: PluginReview) =>
  (requestId: string, runId: RunId): PluginChangeRequest => ({
    kind: 'pluginTrust',
    data: {
      requestId,
      runId,
      plugin: review.name,
      ...(review.version !== null && { version: review.version }),
      digest: review.digest,
      path: review.path,
      skills: review.skills,
      programs: review.programs,
      servers: review.servers,
      ...(review.native !== null && {
        native: {
          description: review.native.description,
          provides: review.native.provides,
        },
      }),
      review: review.lines,
    },
  });

/** What a change answers: what happened, and when it reaches the run. */
const NEXT_STEP = 'It takes effect from your next step.';

const runPluginManager = Effect.fn('plugin_manager.call')(function* (
  call: RunToolCall,
  input: PluginManagerInput,
) {
  const { roots } = call.env;
  const fail = (error: { readonly message: string }) =>
    new ToolError(error.message);
  switch (input.command) {
    case 'list': {
      const plugins = yield* InstalledPlugins.list(roots);
      const table = yield* ToolRegistry;
      return {
        status: 'executed' as const,
        output:
          plugins.length === 0
            ? 'No plugin is installed.'
            : [
                'Installed plugins:',
                ...plugins.map((plugin) => listingLine(plugin, table)),
              ].join('\n'),
        summary: `Listed ${plugins.length} plugin${plugins.length === 1 ? '' : 's'}`,
      };
    }
    case 'install': {
      // A relative folder is the run's; a run with no workspace names an
      // absolute one.
      const cwd = call.env.workingDirectory ?? roots.workspace;
      if (cwd === undefined && !path.isAbsolute(input.source))
        return yield* new ToolError(
          'This run has no workspace: give the plugin folder as an absolute path.',
        );
      const origin = InstalledPlugins.origin(
        input.source,
        cwd ?? path.parse(input.source).root,
        undefined,
      );
      if (Result.isFailure(origin)) return yield* fail(origin.failure);
      const added = yield* InstalledPlugins.install(
        origin.success,
        [],
        roots,
      ).pipe(Effect.mapError(fail));
      const names = added.map(({ name }) => name).join(', ');
      return {
        status: 'executed' as const,
        output: `Installed ${names}, disabled. \`enable\` asks the person to trust it and loads it.`,
        summary: `Installed ${names}`,
      };
    }
    case 'enable': {
      const shown: string[] = [];
      // Native code a person trusted and then disabled is loaded again
      // only on a person's own answer, as it was first trusted: a run's
      // policy or grants never turn it back on. `enable` asks below when
      // the plugin is not trusted as it is.
      const now = yield* InstalledPlugins.review(input.name, roots).pipe(
        Effect.catchTags({ PluginError: fail, PluginRequestError: fail }),
      );
      if (now.review.native !== null && now.trusted && !now.enabled) {
        yield* approved(call, asTrust(now.review), input.name);
        shown.push(...now.review.lines);
      }
      yield* InstalledPlugins.enable(input.name, roots, (review) => {
        shown.push(...review.lines);
        return approved(
          call,
          asTrust(review),
          review.native === null ? null : review.name,
        );
      }).pipe(
        Effect.catchTags({ PluginError: fail, PluginRequestError: fail }),
      );
      // A person who declines fails the call (`approved`), so it is enabled
      // here.
      return {
        status: 'executed' as const,
        output: [
          `Enabled ${input.name}. ${NEXT_STEP}`,
          ...(shown.length === 0
            ? ['It was trusted as it is already.']
            : [
                'What the person trusted:',
                ...shown.map((line) => `  ${line}`),
              ]),
        ].join('\n'),
        summary: `Enabled ${input.name}`,
      };
    }
    case 'disable': {
      yield* approved(
        call,
        asCommand(`Disable the plugin ${input.name}, as this agent asks.`),
      );
      yield* InstalledPlugins.disable(input.name, roots).pipe(
        Effect.mapError(fail),
      );
      return {
        status: 'executed' as const,
        output: `Disabled ${input.name}; it stays installed and trusted. ${NEXT_STEP}`,
        summary: `Disabled ${input.name}`,
      };
    }
    case 'remove': {
      yield* approved(
        call,
        asCommand(
          `Remove the plugin ${input.name} and the trust given to it, as this agent asks.`,
        ),
      );
      const removed = yield* InstalledPlugins.remove(input.name, roots).pipe(
        Effect.mapError(fail),
      );
      return {
        status: 'executed' as const,
        output: `Removed ${removed.name}${removed.local ? `; its folder ${removed.path} is left in place` : ''}. ${NEXT_STEP}`,
        summary: `Removed ${removed.name}`,
      };
    }
  }
});

/** The `plugin_manager` tool. */
export const PluginManagerTool = defineTool({
  name: 'plugin_manager',
  // Enabling, disabling and removing ask the person in the body, with what
  // the plugin carries; a listing and an install ask nothing.
  requiresApproval: 'inBody',
  description: `Manage the plugins you load: list them, install one, and enable, disable or remove one. A plugin is a folder that can carry skills, agents, programs, MCP servers, hooks, and a native module: \`${NATIVE_ENTRY_FILE}\` at its root, which runs inside this process and adds tools, services and a section of your instructions. Each call of a native module's tool asks under the approval policy, as an MCP server's tool does, whatever the tool declares, and is stopped after 60 seconds; a call that fails ends alone, its error naming the plugin.

Commands:
- \`list\` (the default) answers every installed plugin: whether it is enabled, whether it is trusted as it is now, and what it carries.
- \`install\` takes \`source\`: a plugin folder, a git URL, or github.com/<owner>/<repo>[@ref]. It records the plugin disabled; nothing in it runs.
- \`enable\` takes \`name\`. Unless the person already trusts the plugin as it is, they are shown what it carries and asked to trust it; once they do, it loads. Any later edit to it withdraws it until it is enabled and trusted again. Enabling a plugin with a native module always asks the person, whatever the approval policy, even one they trusted before and disabled; where no person can be asked, it fails and a person enables it themselves.
- \`disable\` takes \`name\`: it stays installed and trusted, and loads nothing. The person is asked first.
- \`remove\` takes \`name\`: it is forgotten with its trust. The person is asked first.

A change reaches you at your next step (your next request to the model): its tools are offered, or withdrawn, then. A call already running keeps the version it started with; a call a stopped run left unfinished is not run again on another version when the run resumes: it ends with its outcome unknown, and the version loaded then serves your next step. When a newly trusted version of a native module does not load, the version in use before it stays in use until the plugin is fixed or disabled, but only while this process runs: after a restart the plugin is withheld with the new version's reason. \`list\` names the version in use and one that did not load.

A plugin folder has \`.claude-plugin/plugin.json\` (\`{ "name": "<name>" }\`). Its \`${NATIVE_ENTRY_FILE}\` begins with \`export const description = '<one line>';\` and \`export const provides = ['tool:<name>', ...];\` (also \`program:<name>\`, \`module:<name>\`, \`processLayer\`, \`sessionLayer\`, \`prompt\`), and its default export takes \`{ plugins, effect }\` (the plugin authoring surface, and the modules of the Effect library this process runs that a plugin is written with: \`Effect\`, \`Context\`, \`Layer\`, \`Schema\`, \`Stream\`, \`Scope\` and their kin) and returns \`plugins.definePlugin({ id: '<name>', tools: [...] })\`, each tool made with \`plugins.defineTool\`.`,
  schema: PluginManagerInputSchema,
  execute: (input: PluginManagerInput) =>
    inRunSession((call) => runPluginManager(call, input)),
});
