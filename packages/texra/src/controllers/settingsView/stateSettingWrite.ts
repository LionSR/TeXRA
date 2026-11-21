// The one write path every settings surface goes through: the extension and
// desktop settings views and the CLI `/config` panel.
//
// The write announces what it changed for the rest of the process (a row
// that re-routes models, the approval policy); a host owns only its own
// feedback. `applyStateSettingUpdate` owns the subtle boundary rules once:
//   - a value-less message is a no-op (the catalog schemas carry a decoding
//     default, so parsing `undefined` would silently write a default),
//   - null explicitly resets a setting while an omitted value remains a no-op,
//   - a workspace-target config write needs an open workspace folder.
// Which rows a surface may write is the caller's: a settings view looks the
// webview's key up among the rows it renders, the CLI writes the rows its
// `/config` panel lists.

import {
  emitAppSignal,
  Settings,
  type AppSignals,
  type SettingsStores,
} from '@texra-ai/harness/plugins';
import {
  APPROVAL_POLICY_SETTING,
  DISABLED_SKILLS_SETTING,
  DISABLED_SKILL_SOURCES_SETTING,
  formatError,
  type SettingRow,
} from '@texra-ai/harness/schemas';
import { Effect, Result, Schema } from 'effect';

import { SettingsRequestFailed } from '@texra/controllers/settingsView/settingsHostBindings';
import type { TexraSettingRow } from '@texra/shared/settings/settingSurfaces';

/** A row the write path accepts: any catalog row, with TeXRA's write
 *  effects when it has them. */
export type WritableRow = SettingRow & Pick<TexraSettingRow, 'onWrite'>;

/** Outcome of {@link applyStateSettingUpdate}, for host-specific UI feedback. */
export type StateSettingUpdateResult<E extends WritableRow> =
  | { readonly kind: 'ignored' }
  | { readonly kind: 'rejected'; readonly entry: E; readonly error: Error }
  | { readonly kind: 'workspace-required'; readonly entry: E }
  | { readonly kind: 'applied'; readonly entry: E }
  | { readonly kind: 'failed'; readonly entry: E; readonly error: Error };

/**
 * Host-neutral write path for a catalog-backed setting: guard, persist, and
 * announce an applied write to the process: `modelAccessChanged` for a row
 * whose change re-routes models, `approvalPolicyChanged` for the approval
 * policy. The extension and desktop `UPDATE_STATE_SETTING` boundaries and the
 * CLI `/config` panel call it, and each caller adds its UI feedback and its
 * snapshot rebroadcast. A failed persist returns as the `failed` result.
 */
export function applyStateSettingUpdate<E extends WritableRow>(
  entry: E,
  value: unknown,
  roots: SettingsStores & { readonly workspace: string | undefined },
): Effect.Effect<StateSettingUpdateResult<E>, never, AppSignals> {
  if (value === undefined) return Effect.succeed({ kind: 'ignored' });
  const parsed =
    value === null ? null : Schema.decodeUnknownResult(entry.schema)(value);
  if (parsed && !Result.isSuccess(parsed)) {
    return Effect.succeed({ kind: 'rejected', entry, error: parsed.failure });
  }
  if (
    entry.slot === 'config' &&
    entry.configTarget !== 'global' &&
    roots.workspace === undefined
  ) {
    return Effect.succeed({ kind: 'workspace-required', entry });
  }
  const persist =
    parsed === null
      ? Settings.reset(roots, entry)
      : Settings.set(roots, entry, parsed.success);
  return persist.pipe(
    Effect.andThen(
      entry.onWrite?.invalidatesModelOptions
        ? emitAppSignal('modelAccessChanged', undefined)
        : Effect.void,
    ),
    Effect.andThen(
      entry.key === APPROVAL_POLICY_SETTING.key
        ? emitAppSignal('approvalPolicyChanged', undefined)
        : Effect.void,
    ),
    Effect.match({
      onSuccess: () => ({ kind: 'applied', entry }) as const,
      onFailure: (error) => ({ kind: 'failed', entry, error }) as const,
    }),
  );
}

/**
 * Why a write did not land, worded for the person who made it; `undefined`
 * when it landed or asked for nothing. Every surface that writes a setting
 * shows this one sentence.
 */
export function settingWriteFailure(
  result: StateSettingUpdateResult<WritableRow>,
): SettingsRequestFailed | undefined {
  switch (result.kind) {
    case 'applied':
    case 'ignored':
      return undefined;
    case 'workspace-required':
      return new SettingsRequestFailed({
        message: `Open a workspace folder before changing the “${result.entry.title}” setting.`,
      });
    case 'rejected':
      return new SettingsRequestFailed({
        message: formatError(
          `Invalid value for “${result.entry.title}”`,
          result.error,
        ),
        cause: result.error,
      });
    case 'failed':
      return new SettingsRequestFailed({
        message: formatError(
          `Failed to update “${result.entry.title}”`,
          result.error,
        ),
        cause: result.error,
      });
  }
}

/** A disabled-skills list: of skill names, or of skill source scopes. */
type SkillListRow =
  | typeof DISABLED_SKILLS_SETTING
  | typeof DISABLED_SKILL_SOURCES_SETTING;

/**
 * Switch `item` on or off in a disabled-skills list, over the list as stored
 * now rather than as a surface last read it. Two writes to one list that
 * overlap still each read without the other's item, so a surface that can
 * issue them at once serializes them per list.
 */
export function setSkillEnabled(
  row: SkillListRow,
  item: string,
  enabled: boolean,
  roots: SettingsStores & { readonly workspace: string | undefined },
): Effect.Effect<StateSettingUpdateResult<SkillListRow>, never, AppSignals> {
  return Settings.get(roots, row).pipe(
    Effect.flatMap((disabled: readonly string[]) =>
      applyStateSettingUpdate(
        row,
        enabled
          ? disabled.filter((candidate) => candidate !== item)
          : [...new Set([...disabled, item])],
        roots,
      ),
    ),
    // A list that cannot be read is a failed write: nothing was changed.
    Effect.catch((error) =>
      Effect.succeed({ kind: 'failed', entry: row, error } as const),
    ),
  );
}
