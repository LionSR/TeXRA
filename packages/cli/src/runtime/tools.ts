import { Effect } from 'effect';

// Local imports
import { ToolCatalog } from '@texra-ai/harness';
import { ToolRegistry } from '@texra-ai/harness/plugins';
import { visibleToolPlugins } from '@texra/controllers/settingsView/ToolDashboardData';

/**
 * Switch a probed plugin the CLI lists on or off; `false` when it has no
 * switch. A plugin's bundled agents follow its switch (`pluginCatalogLayer`).
 */
export function setCliToolEnabled(id: string, enabled: boolean) {
  return Effect.flatMap(ToolRegistry, ({ entries }) => {
    const def = visibleToolPlugins(entries, 'cli').find(
      ({ card, plugin }) => card.id === id && plugin.availability !== undefined,
    );
    return def?.plugin.toggle !== undefined
      ? Effect.flatMap(ToolCatalog, (catalog) =>
          catalog.setEnabled(id, enabled),
        ).pipe(Effect.as(true))
      : Effect.succeed(false);
  });
}
