// Third-party imports
import { Effect } from 'effect';

// Local imports - skills
import type { SkillLoadIssue } from '@texra-ai/worldline/host';
import { Settings, type SettingsStores } from '@texra-ai/worldline/plugins';
import {
  AGENT_SKILLS_ENABLED_SETTING,
  type SkillDisplayItem,
} from '@texra-ai/worldline/schemas';

/**
 * The notice a skill listing leads with while `texra.skills.enabled` is off:
 * listed skills are then not offered to agents, and a listing must not read
 * as if they were. `undefined` when skills are on; `enableWith` names the
 * control the caller's surface has.
 */
export function readCliSkillsOffNotice(
  stores: SettingsStores,
  enableWith: string,
) {
  return Effect.map(
    Settings.get(stores, AGENT_SKILLS_ENABLED_SETTING),
    (enabled) =>
      enabled
        ? undefined
        : `Skills are off (${AGENT_SKILLS_ENABLED_SETTING.key}); ${enableWith} turns them on for agents.`,
  );
}

export function formatCliSkillIssue(issue: SkillLoadIssue): string {
  const location = issue.path ? ` (${issue.path})` : '';
  return `${issue.severity}: ${issue.message}${location}`;
}

export function formatCliSkillList(
  skills: readonly SkillDisplayItem[],
): string {
  if (skills.length === 0) return 'No skills found.';
  return skills
    .map(({ scope, name, description }) => `${scope}\t${name}\t${description}`)
    .join('\n');
}
