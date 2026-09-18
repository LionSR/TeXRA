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
} from '@skills/runtimeSkills';

// Local imports - CLI runtime
import type { CliContext } from './cliContext';

export async function readCliSkills(
  context: Pick<CliContext, 'cwd' | 'resourcesPath'>,
  options: SkillSourceOptions = {},
): Promise<DiscoverSkillSourcesResult> {
  return filterDiscoveredSkills(
    await discoverSkillSources(defaultSkillSources(context, options)),
  );
}

export async function readCliRuntimeSkills(
  workspaceRoot: string | undefined,
): Promise<DiscoverSkillSourcesResult> {
  return loadEnabledRuntimeSkills(workspaceRoot);
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
