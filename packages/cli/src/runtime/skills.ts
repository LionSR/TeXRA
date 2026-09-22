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
import {
  defaultSkillSources,
  type SkillSourceOptions,
} from '@skills/skillSources';
import {
  filterDiscoveredSkills,
  readDisabledSkills,
} from '@skills/runtimeSkills';

// Local imports - CLI runtime
import type { CliContext } from './cliContext';

/**
 * `stores` are the setting slots of the workspace this listing is for — the
 * roots the command's platform init installed — so the disabled-skill lists
 * come from that project rather than from ambient state.
 */
export function readCliSkills(
  context: Pick<CliContext, 'cwd' | 'resourcesPath'>,
  stores: SettingsStores,
  options: SkillSourceOptions = {},
) {
  return Effect.gen(function* () {
    const result = yield* discoverSkillSources(
      defaultSkillSources(context, options),
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
