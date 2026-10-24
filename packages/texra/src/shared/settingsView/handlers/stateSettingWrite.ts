// Shared routing decision for the generic `UPDATE_STATE_SETTING` command, and
// the one write path every settings surface goes through — the extension and
// desktop settings views plus the CLI `/config` panel.
//
// The hosts share persistence through `Settings` and own only the
// post-write side effects for each outbound snapshot.
// `applyStateSettingUpdate` owns the subtle boundary rules once:
//   - a value-less message is a no-op (the catalog schemas `.prefault()`, so
//     parsing `undefined` would silently write a default),
//   - null explicitly resets a setting while an omitted value remains a no-op,
//   - a settings view writes only rows tagged for a settings-view snapshot;
//     the CLI writes only the rows its `/config` panel lists.

import { Settings, type SettingHost } from '@texra-ai/harness';
import { Effect, Schema } from 'effect';

import {
  type SettingsViewStateSettingEntry,
  type SurfacedSettingEntry,
  APPROVAL_POLICY_CONFIG_KEY,
  type ApprovalPolicy,
  ensureError,
} from '@texra-ai/harness/schemas';
import { TEXRA_SETTINGS } from '@texra/shared/settingsView/texraSettings';
import type { SettingsStores } from '@texra-ai/harness';

/**
 * The rows a host may write: the settings views (extension, desktop) write
 * the rows they render, the CLI writes the rows its `/config` panel lists.
 */
type WritableEntry<H extends SettingHost> = H extends 'cli'
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
  | { readonly kind: 'failed'; readonly entry: E; readonly error: unknown };

/**
 * The write path's own failure. It never leaves this module: the program folds
 * it back into the `failed` result, carrying what the write itself failed with
 * — the store's own `ConfigWriteFailed`, or the state store's own error, or a
 * thrown value from the approval-policy hook — so the hosts report one shape.
 */
class StateSettingWriteFailed extends Schema.TaggedError<StateSettingWriteFailed>()(
  'StateSettingWriteFailed',
  {
    cause: Schema.Defect(),
  },
) {}

export interface StateSettingUpdatePorts<H extends SettingHost = SettingHost> {
  readonly stores: SettingsStores;
  /**
   * The calling surface: it selects which rows are writable (each row's
   * slot is the stores' own host's).
   */
  readonly host: H;
  /**
   * Extension-only guard: a workspace-target config write needs an open
   * workspace folder. Hosts without that constraint (desktop, CLI) omit this.
   */
  readonly requiresOpenWorkspace?: () => boolean;
  /** Applies the approval-policy side effect when that setting changes. */
  readonly onApprovalPolicyChanged?: (policy: ApprovalPolicy) => void;
}

/**
 * Host-neutral write path for a catalog-backed setting: resolve, guard,
 * persist, and apply the approval-policy side effect. Every surface that
 * changes one of these rows calls this — the extension and desktop
 * `UPDATE_STATE_SETTING` boundaries and the CLI `/config` panel — so a row with
 * a runtime side effect cannot be persisted by one surface without the running
 * session being told. Callers own all UI feedback and the outbound snapshot
 * rebroadcast — this performs only the decision and the write. The program
 * carries no error channel: a failed persist or a throwing approval-policy
 * hook settles as the `failed` result the callers already render.
 */
export function applyStateSettingUpdate<H extends SettingHost>(
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
  const parsed = value === null ? null : entry.schema.safeParse(value);
  if (parsed && !parsed.success) {
    return Effect.succeed({ kind: 'rejected', entry, error: parsed.error });
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
      : Settings.set(ports.stores, entry.key, parsed.data);
  return persist.pipe(
    Effect.mapError((cause) => new StateSettingWriteFailed({ cause })),
    Effect.andThen(
      Effect.gen(function* () {
        if (entry.key !== APPROVAL_POLICY_CONFIG_KEY) return;
        const policy = (
          parsed === null
            ? yield* Settings.get(ports.stores, entry.key)
            : parsed.data
        ) as ApprovalPolicy;
        yield* Effect.try({
          try: () => ports.onApprovalPolicyChanged?.(policy),
          catch: ensureError,
        });
      }).pipe(
        Effect.mapError((cause) => new StateSettingWriteFailed({ cause })),
      ),
    ),
    Effect.as({ kind: 'applied', entry } as const),
    Effect.catchTag('StateSettingWriteFailed', (failure) =>
      Effect.succeed({
        kind: 'failed',
        entry,
        error: failure.cause,
      } as const),
    ),
  );
}
