/**
 * Host-neutral write path for the generic `UPDATE_STATE_SETTING` command.
 *
 * The extension and desktop hosts share persistence through settingsAccess and
 * own only the post-write side effects for each outbound snapshot. This
 * controller owns the orchestration once: resolve the write via
 * `resolveStateSettingWrite`, apply the workspace guard, persist, and fire the
 * approval-policy side effect. Callers own all UI feedback and the outbound
 * snapshot rebroadcast — this performs only the decision and the write.
 */

import {
  TEXRA_APPROVAL_POLICY_CONFIG_KEY,
  readPersistedTexraApprovalPolicy,
  type TexraApprovalPolicy,
} from '@shared/approvalPolicy';
import type {
  SettingsViewSnapshot,
  SettingsViewStateSettingEntry,
} from '@shared/schemas';
import {
  resetSetting,
  writeSetting,
  type SettingsStores,
} from '@shared/config/settingsAccess';
import { resolveStateSettingWrite } from '@shared/settingsView/handlers/stateSettingWrite';

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
    write.entry.store === 'config' &&
    write.entry.configTarget !== 'global' &&
    ports.requiresOpenWorkspace?.(write.entry)
  ) {
    return { kind: 'workspace-required', entry: write.entry };
  }
  try {
    await (write.kind === 'reset'
      ? resetSetting(write.entry, ports.stores)
      : writeSetting(write.entry, write.value, ports.stores));
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
