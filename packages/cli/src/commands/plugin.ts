import { defineCommand } from 'citty';
import { Effect, Result } from 'effect';

import {
  installPlugins,
  parsePluginOrigin,
  removePlugin,
  updatePlugins,
  type PluginUpdate,
} from '@common/plugins/installedPlugins';
import {
  PluginRequestError,
  UNLOADED_COMPONENT_LABELS,
} from '@common/plugins/pluginManifest';
import {
  disablePlugin,
  enablePlugin,
  listPlugins,
  type PluginListing,
  type PluginReview,
} from '@common/plugins/pluginTrust';
import type { PluginEnv } from '@common/plugins/installRecord';
import { withProcessServices } from '@platform/processRuntime';

import { CliUsageError, type CliContext } from '../runtime/cliContext';
import { CliExitCode } from '../runtime/exitCodes';
import { initCliPlatform } from '../runtime/initPlatform';
import {
  askCliQuestion,
  writeErrorStderr,
  writeTextStderr,
} from '../runtime/logSinks';

import { defineCliCommand } from './_helpers/defineCliCommand';
import { withUsageSections } from './_helpers/dispatch';
import { GLOBAL_ARGS, collectStringFlagValues } from './_helpers/globalArgs';
import { emitCliResult } from './_helpers/output';
import type { ChildProcessSpawner } from 'effect/unstable/process/ChildProcessSpawner';

/**
 * A mistake in what the user asked (an unknown name, a taken name) exits 2;
 * a plugin or git failure, a declined trust prompt and a refused code plugin
 * exit 1.
 */
function pluginExitCode(error: unknown): number {
  writeErrorStderr(error);
  return error instanceof CliUsageError || error instanceof PluginRequestError
    ? CliExitCode.Usage
    : CliExitCode.AgentError;
}

/**
 * Open the platform for its roots (the global state the record lives in and
 * the global storage the managed plugins live under), then run one plugin
 * operation on the runtime it installed, whose spawner git runs on.
 */
function withPluginEnv<A, E>(
  context: CliContext,
  operation: (env: PluginEnv) => Effect.Effect<A, E, ChildProcessSpawner>,
) {
  return Effect.gen(function* () {
    const services = yield* initCliPlatform({ ...context, quietLogs: true });
    return yield* withProcessServices(
      services.runtime,
      operation(services.roots),
    );
  });
}

const shortCommit = (commit: string | undefined) => commit?.slice(0, 12);

function pluginState(plugin: PluginListing): string {
  if (plugin.code.length > 0) return 'code plugin, cannot be enabled';
  if (!plugin.enabled) return 'disabled';
  return plugin.trusted ? 'enabled' : 'enabled, needs trust';
}

function formatPluginList(plugins: readonly PluginListing[]): string {
  if (plugins.length === 0) {
    return 'No plugins installed. Install one with `texra plugin install <source>`.';
  }
  return plugins
    .map((plugin) => {
      const header = [
        `${plugin.name} (${pluginState(plugin)})`,
        plugin.version,
        plugin.commit
          ? `${plugin.source} @ ${shortCommit(plugin.commit)}`
          : `${plugin.source} (local)`,
      ]
        .filter(Boolean)
        .join('  ');
      if (plugin.problem) return `${header}\n  problem: ${plugin.problem}`;
      const unloaded = [...plugin.code, ...plugin.ignored];
      return [
        header,
        `  contains: skills (${plugin.skillCount}), commands (${plugin.commandCount}), agents (${plugin.agentCount}), MCP servers (${plugin.mcpServers.length === 0 ? 'none' : plugin.mcpServers.join(', ')})`,
        `  not loaded: ${unloaded.length === 0 ? 'none' : unloaded.join(', ')}`,
      ].join('\n');
    })
    .join('\n');
}

function formatPluginUpdate(update: PluginUpdate): string {
  if (update.to === undefined) return `${update.name}: reread (local plugin)`;
  return update.from === update.to
    ? `${update.name}: already at ${shortCommit(update.to)}`
    : `${update.name}: ${shortCommit(update.from)} -> ${shortCommit(update.to)}`;
}

/** Show what a plugin declares on stderr and ask to trust it, on stdin. An
 *  answer that is not yes, or no answer at all, declines. */
const askTrust = (review: PluginReview) => {
  writeTextStderr(
    [
      `Plugin ${review.name}${review.version ? ` ${review.version}` : ''} asks to be trusted:`,
      ...review.lines.map((line) => `  ${line}`),
    ].join('\n'),
  );
  return askCliQuestion(`Trust ${review.name} and enable it? [y/N] `).pipe(
    Effect.map((answer) => /^y(es)?$/i.test(answer.trim())),
    Effect.catch((error) =>
      Effect.sync(() => {
        writeTextStderr(`No answer (${error.message}).`);
        return false;
      }),
    ),
  );
};

const NAME_ARG = {
  type: 'positional',
  required: true,
  description: 'Plugin name from `texra plugin list`',
} as const;

const pluginInstallCommand = defineCliCommand({
  meta: {
    name: 'install',
    description:
      'Install a Claude Code or Codex plugin, disabled until you enable it',
  },
  args: {
    ...GLOBAL_ARGS,
    source: {
      type: 'positional',
      required: true,
      description:
        'github.com/<owner>/<repo>[@ref], a git URL, or a local plugin directory',
    },
    ref: {
      type: 'string',
      valueHint: 'ref',
      description: 'Branch, tag or commit to install from a git URL',
    },
    plugin: {
      type: 'string',
      valueHint: 'name',
      description:
        'Plugin to install from a marketplace; may be repeated. Needed when the marketplace lists more than one',
    },
  },
  catchExitCode: pluginExitCode,
  run: (context, ctx) => {
    // Parsed while building, so a bad source refuses before anything opens.
    const origin = parsePluginOrigin(
      ctx.args.source,
      context.cwd,
      typeof ctx.args.ref === 'string' ? ctx.args.ref : undefined,
    );
    if (Result.isFailure(origin))
      throw new CliUsageError(origin.failure.message);
    const only = collectStringFlagValues(ctx.rawArgs, 'plugin');
    return withPluginEnv(context, (env) =>
      installPlugins(origin.success, only, env).pipe(
        Effect.flatMap((added) =>
          listPlugins(env).pipe(
            Effect.map((all) =>
              all.filter((plugin) =>
                added.some((entry) => entry.name === plugin.name),
              ),
            ),
          ),
        ),
        Effect.map((installed) => {
          emitCliResult(context, {
            json: installed,
            ndjson: installed.map((plugin) => ({
              kind: 'plugin' as const,
              plugin,
            })),
            text: `Installed:\n${formatPluginList(installed)}\nEnable with \`texra plugin enable <name>\`.`,
          });
          return CliExitCode.Success;
        }),
      ),
    );
  },
});

const pluginListCommand = defineCliCommand({
  meta: { name: 'list', description: 'List installed plugins' },
  args: { ...GLOBAL_ARGS },
  catchExitCode: pluginExitCode,
  run: (context) =>
    withPluginEnv(context, (env) =>
      listPlugins(env).pipe(
        Effect.map((plugins) => {
          emitCliResult(context, {
            json: plugins,
            ndjson: plugins.map((plugin) => ({
              kind: 'plugin' as const,
              plugin,
            })),
            text: formatPluginList(plugins),
          });
          return CliExitCode.Success;
        }),
      ),
    ),
});

const pluginRemoveCommand = defineCliCommand({
  meta: {
    name: 'remove',
    description:
      'Remove an installed plugin; what it wrote to history is kept, unread',
  },
  args: { ...GLOBAL_ARGS, name: NAME_ARG },
  catchExitCode: pluginExitCode,
  run: (context, ctx) =>
    withPluginEnv(context, (env) =>
      removePlugin(ctx.args.name, env).pipe(
        Effect.map((removed) => {
          const result = { removed: removed.name, path: removed.path };
          let text = `Removed ${removed.name}.`;
          if (removed.leftover)
            text = `${removed.name} was already forgotten; removed its leftover directory ${removed.path}.`;
          else if (removed.local)
            text = `Removed ${removed.name}. Its directory ${removed.path} is yours and was left in place.`;
          emitCliResult(context, {
            json: result,
            ndjson: {
              kind: 'result',
              result: { command: 'plugin remove', ...result },
            },
            text,
          });
          return CliExitCode.Success;
        }),
      ),
    ),
});

const pluginEnableCommand = defineCliCommand({
  meta: {
    name: 'enable',
    description:
      'Enable an installed plugin, asking to trust the version it is at',
  },
  args: { ...GLOBAL_ARGS, name: NAME_ARG },
  catchExitCode: pluginExitCode,
  run: (context, ctx) =>
    withPluginEnv(context, (env) =>
      enablePlugin(ctx.args.name, env, askTrust).pipe(
        Effect.map((outcome) => {
          const result = {
            name: ctx.args.name,
            enabled: outcome === 'enabled',
          };
          emitCliResult(context, {
            json: result,
            ndjson: {
              kind: 'result',
              result: { command: 'plugin enable', ...result },
            },
            text:
              outcome === 'enabled'
                ? `Enabled ${ctx.args.name}. Open runs load it at their next step.`
                : `Not enabled: ${ctx.args.name} was not trusted.`,
          });
          return outcome === 'enabled'
            ? CliExitCode.Success
            : CliExitCode.AgentError;
        }),
      ),
    ),
});

const pluginDisableCommand = defineCliCommand({
  meta: {
    name: 'disable',
    description:
      'Disable an installed plugin without removing it: it contributes nothing from the next step',
  },
  args: { ...GLOBAL_ARGS, name: NAME_ARG },
  catchExitCode: pluginExitCode,
  run: (context, ctx) =>
    withPluginEnv(context, (env) =>
      disablePlugin(ctx.args.name, env).pipe(
        Effect.map(() => {
          const result = { name: ctx.args.name, enabled: false };
          emitCliResult(context, {
            json: result,
            ndjson: {
              kind: 'result',
              result: { command: 'plugin disable', ...result },
            },
            text: `Disabled ${ctx.args.name}.`,
          });
          return CliExitCode.Success;
        }),
      ),
    ),
});

const pluginUpdateCommand = defineCliCommand({
  meta: {
    name: 'update',
    description:
      'Fetch the latest commit of installed plugins and reread their manifests',
  },
  args: {
    ...GLOBAL_ARGS,
    name: {
      ...NAME_ARG,
      required: false,
      description: 'Plugin to update (default: all)',
    },
  },
  catchExitCode: pluginExitCode,
  run: (context, ctx) =>
    withPluginEnv(context, (env) =>
      updatePlugins(
        typeof ctx.args.name === 'string' ? [ctx.args.name] : [],
        env,
      ).pipe(
        Effect.map((updates) => {
          emitCliResult(context, {
            json: updates,
            ndjson: {
              kind: 'result',
              result: { command: 'plugin update', updates },
            },
            text:
              updates.length === 0
                ? 'No plugins installed.'
                : updates.map(formatPluginUpdate).join('\n'),
          });
          return CliExitCode.Success;
        }),
      ),
    ),
});

export const pluginCommand = withUsageSections(
  defineCommand({
    meta: {
      name: 'plugin',
      description:
        'Install Claude Code and Codex plugins: their skills, commands, agents and MCP servers',
    },
    subCommands: {
      install: pluginInstallCommand,
      list: pluginListCommand,
      remove: pluginRemoveCommand,
      update: pluginUpdateCommand,
      enable: pluginEnableCommand,
      disable: pluginDisableCommand,
    },
  }),
  [
    {
      title: 'EXAMPLES',
      rows: [
        [
          'texra plugin install github.com/LionSR/AgenticPublicationProtocol',
          'install from GitHub, pinned to the fetched commit',
        ],
        ['texra plugin install ./my-plugin', 'use a local plugin in place'],
        [
          'texra plugin install github.com/o/market --plugin paper',
          'install one plugin a marketplace lists',
        ],
        [
          'texra plugin enable paper-protocol',
          'review what it declares, trust it, and load it',
        ],
        ['texra plugin update', 'refetch every installed plugin'],
        [
          'texra plugin disable paper-protocol',
          'unload a plugin without removing it',
        ],
      ],
    },
    {
      title: `TeXRA loads a plugin's skills, commands (as skills) and agents as <plugin>:<name>, and runs its MCP servers. It does not load its ${UNLOADED_COMPONENT_LABELS.join(', ')}; a plugin with hooks or LSP servers runs code and cannot be enabled yet.`,
      rows: [],
    },
  ],
);
