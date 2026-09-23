// Shared routing decision for the generic `UPDATE_STATE_SETTING` command, and
// the one write path every settings surface goes through — the extension and
// desktop settings views plus the CLI `/config` panel.
//
// The hosts share persistence through settingsAccess and own only the
// post-write side effects for each outbound snapshot.
// `applyStateSettingUpdate` owns the subtle boundary rules once:
//   - a value-less message is a no-op (the catalog schemas `.prefault()`, so
//     parsing `undefined` would silently write a default),
//   - null explicitly resets a setting while an omitted value remains a no-op,
//   - only catalog rows tagged for a settings-view snapshot are writable.

import { Data, Effect } from 'effect';

import {
  TEXRA_APPROVAL_POLICY_CONFIG_KEY,
  type TexraApprovalPolicy,
} from '@shared/approvalPolicy';
import {
  settingsViewSettingByKey,
  type SettingHost,
  type SettingsViewSnapshot,
  type SettingsViewStateSettingEntry,
} from '@shared/state/stateSettings';
import {
  readSetting,
  resetSetting,
  writeSetting,
  type SettingsStores,
} from '@shared/config/settingsAccess';

/** Outcome of {@link applyStateSettingUpdate}, for host-specific UI feedback. */
export type StateSettingUpdateResult =
  | { readonly kind: 'ignored' }
  | {
      readonly kind: 'rejected';
      readonly entry: SettingsViewStateSettingEntry;
      readonly error: Error;
    }
  | {
      readonly kind: 'workspace-required';
      readonly entry: SettingsViewStateSettingEntry;
    }
  | { readonly kind: 'applied'; readonly entry: SettingsViewStateSettingEntry }
  | {
      readonly kind: 'failed';
      readonly entry: SettingsViewStateSettingEntry;
      readonly error: unknown;
    };

/**
 * The write path's own failure. It never leaves this module: the program folds
 * it back into the `failed` result, carrying what the write itself failed with
 * — the store's own `ConfigWriteFailed`, or the state store's own error, or a
 * thrown value from the approval-policy hook — so the hosts report one shape.
 */
class StateSettingWriteFailed extends Data.TaggedError(
  'StateSettingWriteFailed',
)<{ readonly cause: unknown }> {}

export interface StateSettingUpdatePorts {
  readonly stores: SettingsStores;
  /**
   * The calling host, so slot resolution uses that host's own row entry
   * instead of assuming the extension's.
   */
  readonly host: SettingHost;
  /**
   * Extension-only guard: a workspace-target config write needs an open
   * workspace folder. Hosts without that constraint (desktop, CLI) omit this.
   */
  readonly requiresOpenWorkspace?: (
    entry: SettingsViewStateSettingEntry,
  ) => boolean;
  /** Applies the approval-policy side effect when that setting changes. */
  readonly onApprovalPolicyChanged?: (policy: TexraApprovalPolicy) => void;
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
export function applyStateSettingUpdate(
  key: string,
  value: unknown,
  ports: StateSettingUpdatePorts,
): Effect.Effect<StateSettingUpdateResult> {
  if (value === undefined) return Effect.succeed({ kind: 'ignored' });
  const entry = settingsViewSettingByKey(key);
  if (!entry) return Effect.succeed({ kind: 'ignored' });
  const parsed = value === null ? null : entry.schema.safeParse(value);
  if (parsed && !parsed.success) {
    return Effect.succeed({ kind: 'rejected', entry, error: parsed.error });
  }
  if (
    entry.slots[ports.host] === 'config' &&
    entry.configTarget !== 'global' &&
    ports.requiresOpenWorkspace?.(entry)
  ) {
    return Effect.succeed({ kind: 'workspace-required', entry });
  }
  const persist =
    parsed === null
      ? resetSetting(entry, ports.stores, ports.host)
      : writeSetting(entry, parsed.data, ports.stores, ports.host);
  return persist.pipe(
    Effect.mapError((cause) => new StateSettingWriteFailed({ cause })),
    Effect.andThen(
      Effect.gen(function* () {
        if (entry.key !== TEXRA_APPROVAL_POLICY_CONFIG_KEY) return;
        const policy = (
          parsed === null
            ? yield* readSetting(entry, ports.stores, ports.host)
            : parsed.data
        ) as TexraApprovalPolicy;
        yield* Effect.try({
          try: () => ports.onApprovalPolicyChanged?.(policy),
          catch: (cause) => new StateSettingWriteFailed({ cause }),
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

/**
 * Rebroadcast posters for every {@link SettingsViewSnapshot}. A `Record` (not a
 * `switch`) so a new snapshot variant fails the object-literal check at both
 * call sites instead of silently falling through a `default`.
 */
export type SettingsSnapshotPosters<T = void | Promise<void>> = Record<
  SettingsViewSnapshot,
  () => T
>;
