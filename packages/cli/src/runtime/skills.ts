// Third-party imports
import { Effect } from 'effect';

// Local imports - skills
import type { SettingsStores } from '@shared/config/settingsAccess';
import {
  discoverSkillSources,
  type DiscoverSkillSourcesResult,
  type SkillLoadIssue,
  type SourcedSkill,
} from '@skills/loadSkills';
import type { SkillSourceOptions } from '@skills/skillSources';
import {
  filterDiscoveredSkills,
  readDisabledSkills,
  runtimeSkillSources,
} from '@skills/runtimeSkills';

/**
 * Fold the contributions the command's platform init installed for `cwd`,
 * with this command's own source flags in place of the process-wide ones.
 * `stores` are the setting slots of the workspace this listing is for — the
 * roots that init installed — so the disabled-skill lists come from that
 * project rather than from ambient state.
 */
export function readCliSkills(
  cwd: string,
  stores: SettingsStores,
  options: SkillSourceOptions = {},
) {
  return Effect.gen(function* () {
    const result = yield* discoverSkillSources(
      runtimeSkillSources(cwd, options),
    );
    return filterDiscoveredSkills(result, yield* readDisabledSkills(stores));
  });
}

export function formatCliSkillIssue(issue: SkillLoadIssue): string {
  const location = issue.path ? ` (${issue.path})` : '';
  return `${issue.severity}: ${issue.message}${location}`;
}

export function formatCliSkillList(skills: readonly SourcedSkill[]): string {
  if (skills.length === 0) return 'No skills found.';
  return skills
    .map(
      (entry) =>
        `${entry.source.scope}\t${entry.skill.name}\t${entry.skill.description}`,
    )
    .join('\n');
}
