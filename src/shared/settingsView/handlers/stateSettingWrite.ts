// Shared routing decision for the generic `UPDATE_STATE_SETTING` command.
//
// The extension and desktop hosts share persistence through settingsAccess and
// own only the post-write side effects for each outbound snapshot. This
// resolver owns the subtle boundary rules once:
//   - a value-less message is a no-op (the catalog schemas `.prefault()`, so
//     parsing `undefined` would silently write a default),
//   - null explicitly resets a setting while an omitted value remains a no-op,
//   - only catalog rows tagged for a settings-view snapshot are writable.

import {
  TEXRA_APPROVAL_POLICY_CONFIG_KEY,
  readPersistedTexraApprovalPolicy,
  type TexraApprovalPolicy,
} from '@shared/approvalPolicy';
import {
  settingsViewSettingByKey,
  type SettingHost,
  type SettingsViewSnapshot,
  type SettingsViewStateSettingEntry,
} from '@shared/schemas';
import {
  resetSetting,
  writeSetting,
  type SettingsStores,
} from '@shared/config/settingsAccess';

/**
 * A validated state-setting write/reset, a rejected catalog value, or `null`
 * when the message must be ignored (value-less, unknown key, or a catalog row
 * this settings view does not own).
 */
type StateSettingWrite =
  | {
      readonly kind: 'write';
      readonly entry: SettingsViewStateSettingEntry;
      readonly value: unknown;
    }
  | {
      readonly kind: 'reset';
      readonly entry: SettingsViewStateSettingEntry;
    }
  | {
      readonly kind: 'rejected';
      readonly entry: SettingsViewStateSettingEntry;
      readonly error: Error;
    }
  | null;

/**
 * Validate a `{key, value}` write against the unified settings-view catalog and
 * identify its rebroadcast owner, or return `null` to ignore it. This function
 * performs no I/O.
 */
export function resolveStateSettingWrite(
  key: string,
  value: unknown,
): StateSettingWrite {
  if (value === undefined) return null;
  const entry = settingsViewSettingByKey(key);
  if (!entry) return null;
  if (value === null) return { kind: 'reset', entry };
  const parsed = entry.schema.safeParse(value);
  if (!parsed.success) return { kind: 'rejected', entry, error: parsed.error };
  return { kind: 'write', entry, value: parsed.data };
}

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
 * Host-neutral write path for a generic `UPDATE_STATE_SETTING` message:
 * resolve, guard, persist, and apply the approval-policy side effect. Callers
 * own all UI feedback and the outbound snapshot rebroadcast — this performs
 * only the decision and the write.
 */
export async function applyStateSettingUpdate(
  key: string,
  value: unknown,
  ports: StateSettingUpdatePorts,
): Promise<StateSettingUpdateResult> {
  const write = resolveStateSettingWrite(key, value);
  if (!write) return { kind: 'ignored' };
  if (write.kind === 'rejected') {
    return { kind: 'rejected', entry: write.entry, error: write.error };
  }
  if (
    write.entry.slots[ports.host] === 'config' &&
    write.entry.configTarget !== 'global' &&
    ports.requiresOpenWorkspace?.(write.entry)
  ) {
    return { kind: 'workspace-required', entry: write.entry };
  }
  try {
    await (write.kind === 'reset'
      ? resetSetting(write.entry, ports.stores, ports.host)
      : writeSetting(write.entry, write.value, ports.stores, ports.host));
    if (write.entry.key === TEXRA_APPROVAL_POLICY_CONFIG_KEY) {
      ports.onApprovalPolicyChanged?.(
        write.kind === 'reset'
          ? readPersistedTexraApprovalPolicy((k, fallback) =>
              ports.stores.config.get(k, fallback),
            )
          : (write.value as TexraApprovalPolicy),
      );
    }
    return { kind: 'applied', entry: write.entry };
  } catch (error) {
    return { kind: 'failed', entry: write.entry, error };
  }
}

/**
 * Rebroadcast posters for every {@link SettingsViewSnapshot}. A `Record` (not a
 * `switch`) so a new snapshot variant fails the object-literal check at both
 * call sites instead of silently falling through a `default`.
 */
export type SettingsSnapshotPosters = Record<
  SettingsViewSnapshot,
  () => void | Promise<void>
>;

/** Rebroadcasts the settings-view snapshot a state-setting write belongs to. */
export async function postStateSettingSnapshot(
  snapshot: SettingsViewSnapshot,
  posters: SettingsSnapshotPosters,
): Promise<void> {
  await posters[snapshot]();
}
