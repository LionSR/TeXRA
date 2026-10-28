// Shared routing decision for the generic `UPDATE_STATE_SETTING` command, and
// the one write path every settings surface goes through — the extension and
// desktop settings views plus the CLI `/config` panel.
//
// The hosts share persistence through `Settings` and own the post-write
// side effects: the row's `onWrite` reaction and the approval-policy repaint.
// `applyStateSettingUpdate` owns the subtle boundary rules once:
//   - a value-less message is a no-op (the catalog schemas carry a decoding
//     default, so parsing `undefined` would silently write a default),
//   - null explicitly resets a setting while an omitted value remains a no-op,
//   - a settings view writes only rows tagged for a settings-view snapshot;
//     the CLI writes only the rows its `/config` panel lists.

import { Settings } from '@texra-ai/harness/host';
import { Effect, Result, Schema } from 'effect';

import { TEXRA_SETTINGS } from '@texra/shared/settingsView/texraSettings';
import type {
  SettingsViewStateSettingEntry,
  SurfacedSettingEntry,
} from '@texra-ai/harness/schemas';
import type { SettingsStores } from '@texra-ai/harness/host';

/** The surfaces that write a setting: a settings view's host, or the CLI. */
type SettingSurface = 'vscode' | 'desktop' | 'cli';

/**
 * The rows a host may write: the settings views (extension, desktop) write
 * the rows they render, the CLI writes the rows its `/config` panel lists.
 */
type WritableEntry<H extends SettingSurface> = H extends 'cli'
  ? SurfacedSettingEntry
  : SettingsViewStateSettingEntry;

/** Outcome of {@link applyStateSettingUpdate}, for host-specific UI feedback. */
export type StateSettingUpdateResult<
  E extends SurfacedSettingEntry = SurfacedSettingEntry,
> =
  | { readonly kind: 'ignored' }
  | { readonly kind: 'rejected'; readonly entry: E; readonly error: Error }
  | { readonly kind: 'workspace-required'; readonly entry: E }
  | { readonly kind: 'applied'; readonly entry: E }
  | { readonly kind: 'failed'; readonly entry: E; readonly error: Error };

export interface StateSettingUpdatePorts<
  H extends SettingSurface = SettingSurface,
> {
  readonly stores: SettingsStores;
  /**
   * The calling surface: it selects which rows are writable.
   */
  readonly host: H;
  /**
   * Extension-only guard: a workspace-target config write needs an open
   * workspace folder. Hosts without that constraint (desktop, CLI) omit this.
   */
  readonly requiresOpenWorkspace?: () => boolean;
}

/**
 * Host-neutral write path for a catalog-backed setting: resolve, guard and
 * persist. The extension and desktop `UPDATE_STATE_SETTING` boundaries and the
 * CLI `/config` panel call it, and each caller applies the row's write
 * consequences (`onWrite`, the approval-policy repaint), its UI feedback and
 * its snapshot rebroadcast. A failed persist returns as the `failed` result.
 */
export function applyStateSettingUpdate<H extends SettingSurface>(
  key: string,
  value: unknown,
  ports: StateSettingUpdatePorts<H>,
): Effect.Effect<StateSettingUpdateResult<WritableEntry<H>>> {
  if (value === undefined) return Effect.succeed({ kind: 'ignored' });
  // Sound: the lookup matches the host, which is what `WritableEntry` keys on.
  const entry = (
    ports.host === 'cli'
      ? TEXRA_SETTINGS.cliByKey(key)
      : TEXRA_SETTINGS.settingsViewByKey(key)
  ) as WritableEntry<H> | undefined;
  if (!entry) return Effect.succeed({ kind: 'ignored' });
  const parsed =
    value === null ? null : Schema.decodeUnknownResult(entry.schema)(value);
  if (parsed && !Result.isSuccess(parsed)) {
    return Effect.succeed({ kind: 'rejected', entry, error: parsed.failure });
  }
  if (
    entry.slot === 'config' &&
    entry.configTarget !== 'global' &&
    ports.requiresOpenWorkspace?.()
  ) {
    return Effect.succeed({ kind: 'workspace-required', entry });
  }
  const persist =
    parsed === null
      ? Settings.reset(ports.stores, entry.key)
      : Settings.set(ports.stores, entry.key, parsed.success);
  return persist.pipe(
    Effect.match({
      onSuccess: () => ({ kind: 'applied', entry }) as const,
      onFailure: (error) => ({ kind: 'failed', entry, error }) as const,
    }),
  );
}
