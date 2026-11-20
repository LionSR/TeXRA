import { Effect, type FileSystem, Option, Result } from 'effect';
import { Argument, Command, Flag } from 'effect/cli';

import {
  InstalledPlugins,
  PluginRequestError,
  type PluginEnv,
  type PluginListing,
  type PluginReview,
  type PluginUpdate,
} from '@texra-ai/harness/host';

import type { PluginRow } from '@texra/shared/settingsView/settingsViewMessages';
import {
  PLUGINS_PAGE,
  pluginRowProblem,
  pluginRowState,
  pluginRowTrust,
} from '@ui/copy/plugins';

import { CliInvocation, CliUsageError } from '../runtime/platform/cliContext';
import { CliExitCode } from '../runtime/platform/exitCodes';
import { cliPlatform } from '../runtime/platform/initPlatform';
import {
  confirmCliQuestion,
  writeErrorStderr,
  writeTextStderr,
} from '../runtime/platform/logSinks';

import { cliCommand } from './_helpers/cliCommand';
import { cliResult, commandResult, emitCliResult } from './_helpers/output';
import type { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner';

/**
 * A mistake in what the user asked (an unknown name, a taken name) exits 2;
 * a plugin or git failure, a declined trust prompt and a refused plugin with
 * LSP servers exit 1.
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
 * operation, whose spawner git runs on.
 */
const withPluginEnv = Effect.fn('withPluginEnv')(function* <A, E>(
  operation: (
    env: PluginEnv,
  ) => Effect.Effect<
    A,
    E,
    ChildProcessSpawner | FileSystem.FileSystem | CliInvocation
  >,
) {
  return yield* operation((yield* cliPlatform).roots);
});

const shortCommit = (commit: string | undefined) => commit?.slice(0, 12);

function formatPluginList(plugins: readonly PluginListing[]): string {
  if (plugins.length === 0) {
    return 'No plugins installed. Install one with `texra plugin install <source>`.';
  }
  return plugins
    .map((plugin) => {
      // The words for a plugin's state are the Plugins page's and /plugins'.
      const row: PluginRow = { kind: 'installed', plugin, usedBy: [] };
      const trust = pluginRowTrust(row);
      const header = [
        `${plugin.name} (${pluginRowState(row)}${trust === null ? '' : `, ${trust}`})`,
        plugin.version,
        plugin.commit
          ? `${plugin.source} @ ${shortCommit(plugin.commit)}`
          : `${plugin.source} (local)`,
      ]
        .filter(Boolean)
        .join('  ');
      const problem = pluginRowProblem(row);
      const lines =
        problem === null ? [header] : [header, `  problem: ${problem}`];
      if (plugin.problem) return lines.join('\n');
      const unloaded = [...plugin.code, ...plugin.ignored];
      return [
        ...lines,
        `  contains: skills (${plugin.skillCount}), commands (${plugin.commandCount}), agents (${plugin.agentCount}), programs (${plugin.programs.length === 0 ? 'none' : plugin.programs.join(', ')}), MCP servers (${plugin.mcpServers.length === 0 ? 'none' : plugin.mcpServers.join(', ')}), hooks (${plugin.hooks.length}), native code (${plugin.native === null ? 'none' : InstalledPlugins.describeNative(plugin.native.provides)})`,
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
  return confirmCliQuestion(
    PLUGINS_PAGE.trustQuestion(review.name, review.version),
    {
      default: false,
    },
  ).pipe(
    Effect.catch((error) =>
      Effect.sync(() => {
        writeTextStderr(`No answer (${error.message}).`);
        return false;
      }),
    ),
  );
};

const NAME_ARG = Argument.String('name').pipe(
  Argument.withDescription('Plugin name from `texra plugin list`'),
);

const pluginInstallCommand = cliCommand('install', {
  description:
    'Install a Claude Code or Codex plugin, disabled until you enable it',
  config: {
    source: Argument.String('source').pipe(
      Argument.withDescription(
        'github.com/<owner>/<repo>[@ref], a git URL, or a local plugin directory',
      ),
    ),
    ref: Flag.String('ref').pipe(
      Flag.withMetavar('ref'),
      Flag.withDescription('Branch, tag or commit to install from a git URL'),
      Flag.optional,
    ),
    plugin: Flag.String('plugin').pipe(
      Flag.withMetavar('name'),
      Flag.withDescription(
        'Plugin to install from a marketplace; may be repeated. Needed when the marketplace lists more than one',
      ),
      Flag.atLeast(0),
    ),
  },
  catchExitCode: pluginExitCode,
  run: (context, input) => {
    // Parsed while building, so a bad source refuses before anything opens.
    const origin = InstalledPlugins.origin(
      input.source,
      context.cwd,
      Option.getOrUndefined(input.ref),
    );
    if (Result.isFailure(origin))
      throw new CliUsageError({ message: origin.failure.message });
    const only = input.plugin;
    return withPluginEnv((env) =>
      InstalledPlugins.install(origin.success, only, env).pipe(
        Effect.flatMap((added) =>
          InstalledPlugins.list(env).pipe(
            Effect.map((all) =>
              all.filter((plugin) =>
                added.some((entry) => entry.name === plugin.name),
              ),
            ),
          ),
        ),
        Effect.flatMap((installed) =>
          emitCliResult(
            cliResult(
              'plugin',
              installed,
              `Installed:\n${formatPluginList(installed)}\nEnable with \`texra plugin enable <name>\`.`,
            ),
          ),
        ),
      ),
    );
  },
});

const pluginListCommand = cliCommand('list', {
  description: 'List installed plugins',
  config: {},
  catchExitCode: pluginExitCode,
  run: () =>
    withPluginEnv((env) =>
      InstalledPlugins.list(env).pipe(
        Effect.flatMap((plugins) =>
          emitCliResult(
            cliResult('plugin', plugins, formatPluginList(plugins)),
          ),
        ),
      ),
    ),
});

/** One plugin in full: its listing, each hook it runs, and every hook or
 *  event it configures that TeXRA does not run. */
const formatPluginShow = Effect.fn('formatPluginShow')(function* (
  plugin: PluginListing,
) {
  const listed = formatPluginList([plugin]);
  if (plugin.problem) return listed;
  const hooks = yield* Effect.forEach(
    plugin.hooks,
    InstalledPlugins.describeHook,
  );
  return [
    listed,
    plugin.hooks.length === 0 ? '  hooks: none' : '  hooks:',
    ...hooks.map((line) => `    ${line}`),
    ...(plugin.unsupportedHooks.length === 0
      ? []
      : [
          '  unsupported hooks (not run):',
          ...plugin.unsupportedHooks.map((line) => `    ${line}`),
        ]),
  ].join('\n');
});

const pluginShowCommand = cliCommand('show', {
  description:
    'Show one installed plugin: what it contains, its hooks, and what TeXRA does not run',
  config: { name: NAME_ARG },
  catchExitCode: pluginExitCode,
  run: (_, input) =>
    withPluginEnv((env) =>
      InstalledPlugins.list(env).pipe(
        Effect.flatMap((plugins) => {
          const plugin = plugins.find(({ name }) => name === input.name);
          if (plugin === undefined)
            return Effect.fail(
              new PluginRequestError({
                message: `No plugin named ${input.name} is installed.`,
              }),
            );
          return Effect.flatMap(formatPluginShow(plugin), (text) =>
            emitCliResult(cliResult('plugin', plugin, text)),
          );
        }),
      ),
    ),
});

const pluginRemoveCommand = cliCommand('remove', {
  description:
    'Remove an installed plugin; what it wrote to history is kept, unread',
  config: { name: NAME_ARG },
  catchExitCode: pluginExitCode,
  run: (_, input) =>
    withPluginEnv((env) =>
      InstalledPlugins.remove(input.name, env).pipe(
        Effect.flatMap((removed) => {
          const result = { removed: removed.name, path: removed.path };
          let text = `Removed ${removed.name}.`;
          if (removed.leftover)
            text = `${removed.name} was already forgotten; removed its leftover directory ${removed.path}.`;
          else if (removed.local)
            text = `Removed ${removed.name}. Its directory ${removed.path} is yours and was left in place.`;
          return emitCliResult(commandResult('plugin remove', result, text));
        }),
      ),
    ),
});

const pluginEnableCommand = cliCommand('enable', {
  description:
    'Enable an installed plugin, asking to trust the version it is at',
  config: { name: NAME_ARG },
  catchExitCode: pluginExitCode,
  run: (_, input) =>
    withPluginEnv((env) =>
      InstalledPlugins.enable(input.name, env, askTrust).pipe(
        Effect.flatMap((outcome) => {
          const result = {
            name: input.name,
            enabled: outcome === 'enabled',
          };
          return emitCliResult(
            commandResult(
              'plugin enable',
              result,
              outcome === 'enabled'
                ? `Enabled ${input.name}. Open runs load it at their next step.`
                : PLUGINS_PAGE.declined(input.name),
            ),
          ).pipe(
            Effect.as(
              outcome === 'enabled'
                ? CliExitCode.Success
                : CliExitCode.AgentError,
            ),
          );
        }),
      ),
    ),
});

const pluginDisableCommand = cliCommand('disable', {
  description:
    'Disable an installed plugin without removing it: it contributes nothing from the next step',
  config: { name: NAME_ARG },
  catchExitCode: pluginExitCode,
  run: (_, input) =>
    withPluginEnv((env) =>
      InstalledPlugins.disable(input.name, env).pipe(
        Effect.flatMap(() => {
          const result = { name: input.name, enabled: false };
          return emitCliResult(
            commandResult('plugin disable', result, `Disabled ${input.name}.`),
          );
        }),
      ),
    ),
});

const pluginUpdateCommand = cliCommand('update', {
  description:
    'Fetch the latest commit of installed plugins and reread their manifests',
  config: {
    name: Argument.String('name').pipe(
      Argument.withDescription('Plugin to update (default: all)'),
      Argument.optional,
    ),
  },
  catchExitCode: pluginExitCode,
  run: (_, input) =>
    withPluginEnv((env) =>
      InstalledPlugins.update(Option.toArray(input.name), env).pipe(
        Effect.flatMap((updates) =>
          emitCliResult({
            json: updates,
            ndjson: {
              kind: 'result',
              result: { command: 'plugin update', updates },
            },
            text:
              updates.length === 0
                ? 'No plugins installed.'
                : updates.map(formatPluginUpdate).join('\n'),
          }),
        ),
      ),
    ),
});

const EXAMPLES: readonly (readonly [string, string])[] = [
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
    'texra plugin show paper-protocol',
    'list its hooks, and what TeXRA does not run',
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
];

export const pluginCommand = Command.make('plugin').pipe(
  Command.withDescription(
    'Install Claude Code and Codex plugins: their skills, commands, agents, MCP servers and hooks',
  ),
  Command.withSubcommands([
    pluginInstallCommand,
    pluginListCommand,
    pluginShowCommand,
    pluginRemoveCommand,
    pluginUpdateCommand,
    pluginEnableCommand,
    pluginDisableCommand,
  ]),
  Command.withExamples(
    EXAMPLES.map(([command, description]) => ({ command, description })),
  ),
);
