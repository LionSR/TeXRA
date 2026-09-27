/**
 * The Skills page's installed-plugin actions, over the one install record
 * `texra plugin` shares (`@common/plugins`): install from a source the host
 * asks for, enable (showing what the plugin declares in a host dialog and
 * recording the trust the user gives), disable, update and remove. Each
 * repaints the page and reloads the agent catalog, which lists the plugin's
 * agents; a run picks the change up at its next step.
 */
// Third-party imports
import { Effect, Result } from 'effect';

// Local imports - agent runtime
import { refresh as refreshAgentCatalog } from '@agent/index';
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
  listPlugins,
  type PluginReview,
} from '@common/plugins/pluginTrust';
import type { ProcessServices } from '@platform/processRuntime';
import type {
  PluginActionMessage,
  PluginListItem,
} from '@shared/settingsView/pluginMessages';
import { safeHomedir } from '@utils/system/platformPaths';

// Local imports - this module's neighbours
import type {
  SettingsHostBindings,
  SettingsPresentation,
} from './settingsHostBindings';

/** The installed-plugin arm of the settings body and the list it shows. */
export function settingsPluginCommands(ports: {
  readonly roots: PluginEnv & { readonly workspace: string | undefined };
  readonly bindings: SettingsHostBindings;
  readonly present: SettingsPresentation;
  /** Repaint the Skills page, whose list this arm's changes feed. */
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
        'Install a Claude Code or Codex plugin: github.com/<owner>/<repo>[@ref], a git URL, or a local directory',
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

  const act = (message: PluginActionMessage) => {
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
    /** The installed plugins as the Skills page lists them. */
    list: Effect.map(listPlugins(roots), (plugins) =>
      plugins.map((plugin): PluginListItem => ({
        name: plugin.name,
        source: plugin.source,
        commit: plugin.commit,
        version: plugin.version,
        enabled: plugin.enabled,
        trusted: plugin.trusted,
        code: [...plugin.code],
        skillCount: plugin.skillCount,
        commandCount: plugin.commandCount,
        agentCount: plugin.agentCount,
        mcpServers: [...plugin.mcpServers],
        problem: plugin.problem,
      })),
    ),
    handlers: {
      pluginAction: (message: PluginActionMessage) =>
        present
          .reported(`Plugin ${message.action} failed`, act(message))
          .pipe(
            Effect.andThen(refreshAgentCatalog()),
            Effect.andThen(bindings.refreshCatalogs()),
            Effect.andThen(ports.repaint),
          ),
    },
  };
}
