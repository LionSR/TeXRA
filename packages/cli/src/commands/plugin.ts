import * as os from 'node:os';
import * as path from 'node:path';

import { defineCommand } from 'citty';
import { Effect } from 'effect';

import { withProcessServices } from '@platform/processRuntime';

import { CliUsageError, type CliContext } from '../runtime/cliContext';
import { CliExitCode } from '../runtime/exitCodes';
import { initCliPlatform } from '../runtime/initPlatform';
import { writeErrorStderr } from '../runtime/logSinks';
import { DEFERRED_COMPONENT_LABELS } from '../runtime/pluginManifest';
import {
  installPlugins,
  listPlugins,
  removePlugin,
  updatePlugins,
  GIT_URL,
  SAFE_REF,
  type PluginEnv,
  type PluginListing,
  type PluginOrigin,
  type PluginUpdate,
} from '../runtime/plugins';

import { defineCliCommand } from './_helpers/defineCliCommand';
import { withUsageSections } from './_helpers/dispatch';
import { GLOBAL_ARGS, collectStringFlagValues } from './_helpers/globalArgs';
import { emitCliResult } from './_helpers/output';
import type { ChildProcessSpawner } from 'effect/unstable/process/ChildProcessSpawner';

const GITHUB_SHORTHAND =
  /^(?:https?:\/\/)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:@([^@\s]+))?$/;

/**
 * Parse `<source>`: `github.com/<owner>/<repo>[@ref]`, a git URL, or a local
 * directory. Refused here, before anything runs, so a bad source is a usage
 * error. `--ref` applies to git sources only.
 */
function parsePluginSource(
  input: string,
  cwd: string,
  ref: string | undefined,
): PluginOrigin {
  const github = GITHUB_SHORTHAND.exec(input);
  const pinned = github?.[3];
  if (pinned !== undefined && ref !== undefined) {
    throw new CliUsageError(
      `Give the ref once: either ${input} or --ref ${ref}, not both.`,
    );
  }
  const gitRef = pinned ?? ref;
  if (gitRef !== undefined && !SAFE_REF.test(gitRef)) {
    throw new CliUsageError(`"${gitRef}" is not a git branch, tag or commit.`);
  }
  if (github) {
    return {
      kind: 'git',
      url: `https://github.com/${github[1]}/${github[2]}.git`,
      ...(gitRef ? { ref: gitRef } : {}),
    };
  }
  if (GIT_URL.test(input)) {
    return { kind: 'git', url: input, ...(gitRef ? { ref: gitRef } : {}) };
  }
  if (/^[a-z][\w+.-]*:\/\//i.test(input)) {
    throw new CliUsageError(
      `${input} is not a remote git URL (https, ssh or git). Install a local plugin by its directory path.`,
    );
  }
  if (ref !== undefined) {
    throw new CliUsageError('--ref applies to git sources only.');
  }
  const expanded =
    input === '~' || input.startsWith(`~${path.sep}`)
      ? path.join(os.homedir(), input.slice(1))
      : input;
  return { kind: 'local', path: path.resolve(cwd, expanded) };
}

/**
 * A mistake in what the user asked (an unknown name, a taken name, a
 * marketplace that needs `--plugin`) exits 2; a plugin or git failure exits 1.
 */
function pluginExitCode(error: unknown): number {
  writeErrorStderr(error);
  return error instanceof CliUsageError
    ? CliExitCode.Usage
    : CliExitCode.AgentError;
}

/**
 * Open the platform for its setting slots, then run one plugin operation on
 * the runtime it installed, whose spawner git runs on.
 */
function withPluginEnv<A, E>(
  context: CliContext,
  operation: (env: PluginEnv) => Effect.Effect<A, E, ChildProcessSpawner>,
) {
  return Effect.gen(function* () {
    const services = yield* initCliPlatform({ ...context, quietLogs: true });
    return yield* withProcessServices(
      services.runtime,
      operation({
        stores: services.roots,
        pluginsDir: path.join(context.storageRoot, 'plugins'),
      }),
    );
  });
}

const shortCommit = (commit: string | undefined) => commit?.slice(0, 12);

function formatPluginList(plugins: readonly PluginListing[]): string {
  if (plugins.length === 0) {
    return 'No plugins installed. Install one with `texra plugin install <source>`.';
  }
  return plugins
    .map((plugin) => {
      const header = [
        plugin.name,
        plugin.version,
        plugin.commit
          ? `${plugin.source} @ ${shortCommit(plugin.commit)}`
          : `${plugin.source} (local)`,
      ]
        .filter(Boolean)
        .join('  ');
      const detail = plugin.problem
        ? `  problem: ${plugin.problem}`
        : `  contains: skills (${plugin.skillCount}); ignored: ${plugin.ignored.length === 0 ? 'none' : plugin.ignored.join(', ')}`;
      return `${header}\n${detail}`;
    })
    .join('\n');
}

function formatPluginUpdate(update: PluginUpdate): string {
  if (update.to === undefined) return `${update.name}: reread (local plugin)`;
  return update.from === update.to
    ? `${update.name}: already at ${shortCommit(update.to)}`
    : `${update.name}: ${shortCommit(update.from)} -> ${shortCommit(update.to)}`;
}

const NAME_ARG = {
  type: 'positional',
  required: true,
  description: 'Plugin name from `texra plugin list`',
} as const;

const pluginInstallCommand = defineCliCommand({
  meta: {
    name: 'install',
    description: 'Install a Claude Code or Codex plugin and load its skills',
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
    const origin = parsePluginSource(
      ctx.args.source,
      context.cwd,
      typeof ctx.args.ref === 'string' ? ctx.args.ref : undefined,
    );
    const only = collectStringFlagValues(ctx.rawArgs, 'plugin');
    return withPluginEnv(context, (env) =>
      installPlugins(origin, only, env).pipe(
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
            text: `Installed:\n${formatPluginList(installed)}`,
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
    description: 'Remove an installed plugin and its skills',
  },
  args: { ...GLOBAL_ARGS, name: NAME_ARG },
  catchExitCode: pluginExitCode,
  run: (context, ctx) =>
    withPluginEnv(context, (env) =>
      removePlugin(ctx.args.name, env).pipe(
        Effect.map((plugin) => {
          const result = { removed: plugin.name, path: plugin.path };
          emitCliResult(context, {
            json: result,
            ndjson: {
              kind: 'result',
              result: { command: 'plugin remove', ...result },
            },
            text:
              plugin.commit === undefined
                ? `Removed ${plugin.name}. Its directory ${plugin.path} is yours and was left in place.`
                : `Removed ${plugin.name}.`,
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
      description: 'Install Claude Code and Codex plugins for their skills',
    },
    subCommands: {
      install: pluginInstallCommand,
      list: pluginListCommand,
      remove: pluginRemoveCommand,
      update: pluginUpdateCommand,
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
        ['texra plugin update', 'refetch every installed plugin'],
      ],
    },
    {
      title: `TeXRA loads a plugin's skills. It does not load or run its ${DEFERRED_COMPONENT_LABELS.join(', ')}.`,
      rows: [],
    },
  ],
);
