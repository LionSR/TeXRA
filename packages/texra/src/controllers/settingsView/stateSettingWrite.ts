// The one write path every settings surface goes through: the extension and
// desktop settings views and the CLI `/config` panel.
//
// The write announces what it changed for the rest of the process (a row
// that re-routes models, the approval policy); a host owns only its own
// feedback. `applyStateSettingUpdate` owns the subtle boundary rules once:
//   - a value-less message is a no-op (the catalog schemas carry a decoding
//     default, so parsing `undefined` would silently write a default),
//   - null explicitly resets a setting while an omitted value remains a no-op,
//   - a workspace-target config write needs an open workspace folder,
//   - a coding plan's switch is a model-access preference, written by its
//     one operation, which turns it on only when the plan's key is set.
// Which rows a surface may write is the caller's: a settings view looks the
// webview's key up among the rows it renders, the CLI writes the rows its
// `/config` panel lists.

import {
  emitAppSignal,
  Settings,
  type AppSignals,
  type Secrets,
  type SettingsStores,
} from '@texra-ai/worldline/plugins';
import {
  APPROVAL_POLICY_SETTING,
  DISABLED_SKILLS_SETTING,
  DISABLED_SKILL_SOURCES_SETTING,
  formatError,
  type SettingRow,
} from '@texra-ai/worldline/schemas';
import { providerDisplayName } from '@texra-ai/llm';
import { Effect, Result, Schema } from 'effect';

import { setCodingPlanPreference } from '@texra/controllers/modelAccess/modelAccessPreference';
import { CODING_PLAN_SUBSCRIPTIONS } from '@texra/shared/model/codingPlans';

import { SettingsRequestFailed } from '@texra/controllers/settingsView/settingsHostBindings';
import type { TexraSettingRow } from '@texra/shared/settings/settingSurfaces';

/** A row the write path accepts: any catalog row, with TeXRA's write
 *  effects when it has them. */
export type WritableRow = SettingRow & Pick<TexraSettingRow, 'onWrite'>;

/**
 * Outcome of {@link applyStateSettingUpdate}, for host-specific UI feedback.
 * A write that did not land carries the one sentence every surface shows,
 * and whether it is a `notice` (the person can fix it: open a folder, add a
 * key) or an `alert` (the value was invalid or the write failed).
 */
export type StateSettingUpdateResult =
  | { readonly kind: 'ignored' }
  | { readonly kind: 'applied' }
  | {
      readonly kind: 'failed';
      readonly shownAs: 'notice' | 'alert';
      readonly error: SettingsRequestFailed;
    };

const invalidValue = (entry: WritableRow, error: unknown) =>
  ({
    kind: 'failed',
    shownAs: 'alert',
    error: new SettingsRequestFailed({
      message: formatError(`Invalid value for "${entry.title}"`, error),
      cause: error,
    }),
  }) as const;

const writeFailed = (entry: WritableRow, error: unknown) =>
  ({
    kind: 'failed',
    shownAs: 'alert',
    error: new SettingsRequestFailed({
      message: formatError(`Failed to update “${entry.title}”`, error),
      cause: error,
    }),
  }) as const;

/**
 * Host-neutral write path for a catalog-backed setting: guard, persist, and
 * announce an applied write to the process: `modelAccessChanged` for a row
 * whose change re-routes models, `approvalPolicyChanged` for the approval
 * policy. The extension and desktop `UPDATE_STATE_SETTING` boundaries and the
 * CLI `/config` panel call it, and each caller adds its UI feedback and its
 * snapshot rebroadcast. A write that did not land returns as the `failed`
 * result.
 * A coding plan's switch goes through `setCodingPlanPreference`, the one
 * writer of that preference.
 */
export function applyStateSettingUpdate(
  entry: WritableRow,
  value: unknown,
  roots: SettingsStores & { readonly workspace: string | undefined },
): Effect.Effect<StateSettingUpdateResult, never, AppSignals | Secrets> {
  if (value === undefined) return Effect.succeed({ kind: 'ignored' });
  const parsed =
    value === null ? null : Schema.decodeUnknownResult(entry.schema)(value);
  if (parsed && !Result.isSuccess(parsed)) {
    return Effect.succeed(invalidValue(entry, parsed.failure));
  }
  if (
    entry.slot === 'config' &&
    entry.configTarget !== 'global' &&
    roots.workspace === undefined
  ) {
    return Effect.succeed({
      kind: 'failed',
      shownAs: 'notice',
      error: new SettingsRequestFailed({
        message: `Open a project folder before changing "${entry.title}".`,
      }),
    });
  }
  const plan = CODING_PLAN_SUBSCRIPTIONS.find(
    ({ preference }) => preference.key === entry.key,
  );
  if (plan !== undefined && typeof parsed?.success === 'boolean') {
    return setCodingPlanPreference(roots, plan, parsed.success).pipe(
      Effect.match({
        onSuccess: (outcome) =>
          outcome === 'needs-key'
            ? ({
                kind: 'failed',
                shownAs: 'notice',
                error: new SettingsRequestFailed({
                  message: `Add a ${providerDisplayName(plan.apiProvider)} API key before turning on "${entry.title}".`,
                }),
              } as const)
            : ({ kind: 'applied' } as const),
        onFailure: (error) => writeFailed(entry, error),
      }),
    );
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
      onSuccess: () => ({ kind: 'applied' }) as const,
      onFailure: (error) => writeFailed(entry, error),
    }),
  );
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
): Effect.Effect<StateSettingUpdateResult, never, AppSignals | Secrets> {
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
    Effect.catch((error) => Effect.succeed(writeFailed(row, error))),
  );
}
