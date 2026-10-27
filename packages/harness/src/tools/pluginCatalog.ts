/**
 * The process's plugin catalog: the `ToolRegistry` over the plugin list an
 * entry passes to `processLayer`, the tool catalog over it, the
 * user's MCP servers and the installed plugins, following the switches.
 */

// Third-party imports
import {
  Cause,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Result,
  Schedule,
  Stream,
} from 'effect';

// Local imports
import { revisionKey } from '@common/plugins/mcpServers';
import {
  installedPluginId,
  readInstalledPluginLoad,
} from '@common/plugins/pluginTrust';
import { withLogChannel } from '@logger/effectLog';
import { AppState } from '@platform/interfaces';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { toolCatalogLayer } from '@tools/liveTools';
import { mcpPlugin, mcpPluginLoader } from '@tools/mcp/mcpConfig';
import { readDisabledTools, type Plugin } from '@tools/plugins';
import { toolTable, type InstalledToolReader } from '@tools/toolTable';
import { toErrorMessage } from '@utils/errors/errorMessage';

/** A switch apply's backoff: 200 ms doubling, over six retries. */
const SWITCH_READ = Schedule.exponential('200 millis');

/**
 * The process's `ToolRegistry` over the app's `plugins` and the tool catalog
 * (`ToolCatalog`) over it, with the MCP servers of `mcpConfigPath` (a host's is
 * the user's `~/.texra/mcp.json`) and the installed plugins.
 * `processLayer` builds it from the plugin list an entry passes. The layer takes the process `FileSystem`
 * that `processLayer` serves, to read that file, and its
 * `AppState`, which holds the key MCP env values are digested under, the
 * switches and the plugin install record. A switch flipped or a plugin
 * disabled in any process sharing that state reaches the catalog at once
 * (`AppState.changes`), not only at a run's next step, so what follows the
 * catalog outside a run (a plugin layer's lifetime) follows the switch.
 */
export const pluginCatalogLayer = (
  plugins: readonly Plugin[],
  mcpConfigPath: string,
) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const appState = yield* AppState;
      // The configured servers' key: resolved once per process, on the
      // first run that declares an MCP tool. A failed read is not kept: the next run that needs it reads
      // again, so one transient store fault does not stop every server.
      const envKey = yield* revisionKey(appState).pipe(
        Effect.tapError((error) =>
          Effect.logWarning(
            `The MCP revision key could not be read; no MCP server starts until it can: ${error.message}`,
          ).pipe(withLogChannel('mcp')),
        ),
        Effect.cachedWithTTL((exit) =>
          Exit.isSuccess(exit) ? Duration.infinity : Duration.zero,
        ),
      );
      // The installed plugins a step loads: the enabled, trusted ones, and
      // why each other enabled one loads nothing. One that ships only
      // skills loads with no servers.
      const installed: InstalledToolReader = Effect.gen(function* () {
        const {
          loadable,
          withheld,
          envKey: installedKey,
        } = yield* readInstalledPluginLoad({
          globalState: appState,
        }).pipe(Effect.provideService(FileSystem.FileSystem, fs));
        return {
          plugins: loadable.map((source) => {
            const id = installedPluginId(source.record.name);
            return {
              id,
              servers:
                installedKey === undefined
                  ? []
                  : source.plugin.mcpServers.map((server) =>
                      mcpPlugin(server, installedKey, id),
                    ),
              source,
            };
          }),
          warnings: [
            ...withheld,
            ...loadable.flatMap(({ plugin }) =>
              plugin.mcpServers.length > 0 ? plugin.warnings : [],
            ),
          ],
        };
      });
      // The switches as they stand, then again on each change to them,
      // written here or by another process, off the build: a store not
      // readable yet fails no process. A failed read changes nothing, so
      // what is off stays off (every switched plugin, before the first);
      // it is tried again with a bounded backoff, and a change it still
      // misses is logged.
      const switches = appState.changes([GlobalStateKey.DISABLED_TOOLS]).pipe(
        Stream.mapEffect(() =>
          readDisabledTools(appState).pipe(
            Effect.retry({ schedule: SWITCH_READ, times: 6 }),
            Effect.map(Result.succeed),
            Effect.catchCause((cause) =>
              Effect.as(
                Effect.logError(
                  `Tool switches were not applied to the catalog after seven tries; the plugins they switch stay as they were (off, before the first read) until the switches change again: ${toErrorMessage(Cause.squash(cause))}`,
                ),
                Result.failVoid,
              ),
            ),
          ),
        ),
        Stream.filterMap((read) => read),
      );
      return toolCatalogLayer(toolTable(plugins), {
        loader: mcpPluginLoader(fs, mcpConfigPath, envKey),
        installed,
        switches,
      });
    }),
  );
