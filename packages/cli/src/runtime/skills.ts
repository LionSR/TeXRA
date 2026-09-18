// Local imports - skills
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
  loadEnabledRuntimeSkills,
  readDisabledSkills,
} from '@skills/runtimeSkills';
import type { SettingsStores } from '@shared/config/settingsAccess';

// Local imports - CLI runtime
import type { CliContext } from './cliContext';

/**
 * `stores` are the setting slots of the workspace this listing is for — the
 * roots the command's platform init installed — so the disabled-skill lists
 * come from that project rather than from ambient state.
 */
export async function readCliSkills(
  context: Pick<CliContext, 'cwd' | 'resourcesPath'>,
  stores: SettingsStores,
  options: SkillSourceOptions = {},
): Promise<DiscoverSkillSourcesResult> {
  return filterDiscoveredSkills(
    await discoverSkillSources(defaultSkillSources(context, options)),
    readDisabledSkills(stores),
  );
}

export async function readCliRuntimeSkills(
  workspaceRoot: string | undefined,
  stores: SettingsStores,
): Promise<DiscoverSkillSourcesResult> {
  return loadEnabledRuntimeSkills(workspaceRoot, stores);
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
