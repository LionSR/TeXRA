// Third-party imports
import { Effect } from 'effect';

// Local imports - skills
import { type EnabledSkill, type SkillLoadIssue } from '@texra-ai/harness/host';
import { Settings, type SettingsStores } from '@texra-ai/harness/plugins';
import { AGENT_SKILLS_ENABLED_SETTING } from '@texra-ai/harness/schemas';

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

export function formatCliSkillList(skills: readonly EnabledSkill[]): string {
  if (skills.length === 0) return 'No skills found.';
  return skills
    .map(
      ({ display }) =>
        `${display.scope}\t${display.name}\t${display.description}`,
    )
    .join('\n');
}
