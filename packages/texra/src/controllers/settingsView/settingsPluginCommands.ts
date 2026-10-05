/**
 * The Plugins page's installed-plugin actions, over the one install record
 * `texra plugin` shares (`@common/plugins`): install from a GitHub URL, a
 * repository URL or a folder the host asks for, enable (showing what the
 * plugin declares in a host dialog and recording the trust the user gives),
 * disable, update and remove; and opening the user's `mcp.json`, which the
 * page lists read-only. Each change repaints the page and reloads the agent
 * catalog, which lists the plugin's agents; a run picks the change up at its
 * next step.
 */
// Third-party imports
import { Effect, FileSystem, Result } from 'effect';

// Local imports - agent runtime
import {
  installPlugins,
  parsePluginOrigin,
  removePlugin,
  updatePlugins,
} from '@common/plugins/installedPlugins';
import type { PluginEnv } from '@common/plugins/installRecord';
import { PluginRequestError } from '@common/plugins/pluginManifest';
import {
  disablePlugin,
  enablePlugin,
  type PluginReview,
} from '@common/plugins/pluginTrust';
import type { ProcessServices } from '@platform/processRuntime';
import type { PluginActionMessage } from '@texra/shared/settingsView/pluginMessages';
import { USER_MCP_CONFIG_PATH } from '@tools/mcp/mcpConfig';
import { safeHomedir } from '@utils/system/platformPaths';

// Local imports - this module's neighbours
import type {
  SettingsHostBindings,
  SettingsPresentation,
} from './settingsHostBindings';

/** The installed-plugin arm of the settings body. */
export function settingsPluginCommands(ports: {
  readonly roots: PluginEnv & { readonly workspace: string | undefined };
  readonly bindings: SettingsHostBindings;
  readonly present: SettingsPresentation;
  /** Repaint the Plugins page, whose rows this arm's changes feed. */
  readonly repaint: Effect.Effect<void, Error, ProcessServices>;
}) {
  const { roots, bindings, present } = ports;

  const confirmTrust = (review: PluginReview) =>
    bindings.prompt.confirm(
      `Trust ${review.name}${review.version ? ` ${review.version}` : ''} and enable it?`,
      {
        modal: true,
        detail: review.lines.join('\n'),
        confirmLabel: 'Trust and enable',
      },
    );

  const install = Effect.gen(function* () {
    const source = (yield* bindings.prompt.input({
      prompt:
        'Add a Claude Code or Codex plugin: github.com/<owner>/<repo>[@ref], a git URL, or a folder',
      placeHolder: 'github.com/owner/repo',
    }))?.trim();
    if (!source) return;
    const origin = parsePluginOrigin(
      source,
      roots.workspace ?? safeHomedir() ?? '/',
      undefined,
    );
    if (Result.isFailure(origin)) return yield* Effect.fail(origin.failure);
    const added = yield* installPlugins(origin.success, [], roots);
    yield* present.notice(
      `Installed ${added.map(({ name }) => name).join(', ')}. Switch it on to review what it declares and trust it.`,
    );
  });

  /** The file is the one editor of the servers: a missing one is named,
   *  never created, so the page is no second writer of it. */
  const openMcpConfig = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    if (yield* fs.exists(USER_MCP_CONFIG_PATH))
      return yield* bindings.openPath(USER_MCP_CONFIG_PATH);
    yield* present.notice(
      `No MCP servers are configured. Create ${USER_MCP_CONFIG_PATH} as { "mcpServers": { "<name>": { "command": "…", "args": [] } } }, the shape Claude Code's .mcp.json uses.`,
    );
  });

  const act = (
    message: PluginActionMessage & {
      readonly action: Exclude<PluginActionMessage['action'], 'openMcpConfig'>;
    },
  ) => {
    if (message.action === 'install') return install;
    const { name } = message;
    if (name === undefined)
      return Effect.fail(
        new PluginRequestError({
          message: `The ${message.action} action names no plugin.`,
        }),
      );
    switch (message.action) {
      case 'enable':
        return Effect.flatMap(
          enablePlugin(name, roots, confirmTrust),
          (outcome) =>
            outcome === 'declined'
              ? present.notice(`${name} was not trusted, so it stays off.`)
              : Effect.void,
        );
      case 'disable':
        return disablePlugin(name, roots);
      case 'update':
        return updatePlugins([name], roots);
      case 'remove':
        return removePlugin(name, roots);
    }
  };

  return {
    handlers: {
      pluginAction: (message: PluginActionMessage) =>
        message.action === 'openMcpConfig'
          ? present.reported(
              'Could not open the MCP config file',
              openMcpConfig,
            )
          : present
              .reported(
                `Plugin ${message.action} failed`,
                act({ ...message, action: message.action }),
              )
              .pipe(
                Effect.andThen(bindings.refreshCatalogs()),
                Effect.andThen(ports.repaint),
              ),
    },
  };
}
