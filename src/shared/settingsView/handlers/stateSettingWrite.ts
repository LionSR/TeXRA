// Shared routing decision for the generic `UPDATE_STATE_SETTING` command.
//
// The extension and desktop hosts each own the actual persist + rebroadcast per
// family (git-author vs external-agent), but the decision of *whether* and *as
// which family* to write a given {key, value} is identical and drift-prone.
// This resolver owns that decision once so the two hosts can't diverge on the
// subtle rules:
//   - a value-less message is a no-op (the catalog schemas `.prefault()`, so
//     parsing `undefined` would resolve to the default and silently reset the
//     setting — this command has no clear-to-default semantics), and
//   - only the git-author and external-agent categories are routable; any other
//     catalog category is ignored rather than mis-persisted through the agent
//     path or refreshing the wrong UI.

import { stateSettingByKey } from '@shared/schemas/stateSettings';
import type { WorkspaceStateKey } from '@shared/state/stateKeys';

/**
 * A validated, classified state-setting write, or `null` when the message must
 * be ignored (value-less, unknown key, schema-rejected value, or a catalog
 * category this settings view does not own). `git` values stay `unknown`
 * (boolean or string); `agent` values are the string/enum the six external-agent
 * settings all use.
 */
type StateSettingWrite =
  | {
      readonly family: 'git';
      readonly key: WorkspaceStateKey;
      readonly value: unknown;
    }
  | {
      readonly family: 'agent';
      readonly key: WorkspaceStateKey;
      readonly value: string;
    }
  | null;

/**
 * Validate a `{key, value}` write against the `STATE_SETTINGS` catalog and
 * classify it into the owning family, or return `null` to ignore it. Hosts
 * dispatch the returned family to their own updater; this function performs no
 * I/O.
 */
export function resolveStateSettingWrite(
  key: string,
  value: unknown,
): StateSettingWrite {
  if (value === undefined) return null;
  const entry = stateSettingByKey(key);
  if (!entry) return null;
  const parsed = entry.schema.safeParse(value);
  if (!parsed.success) return null;
  if (entry.category === 'git') {
    return { family: 'git', key: key as WorkspaceStateKey, value: parsed.data };
  }
  if (entry.category === 'ai-agents') {
    return {
      family: 'agent',
      key: key as WorkspaceStateKey,
      value: parsed.data as string,
    };
  }
  return null;
}
