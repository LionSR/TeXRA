// Local imports - skills
import {
  discoverSkillSources,
  type DiscoverSkillSourcesResult,
  type SkillLoadIssue,
  type SkillSource,
  type SourcedSkill,
} from '@skills/loadSkills';
import {
  defaultSkillSources,
  type SkillSourceOptions,
} from '@skills/skillSources';
import { listRuntimeSkillSources } from '@skills/runtimeSkills';

// Local imports - CLI runtime
import type { CliContext } from './cliContext';

export type CliSkillDiscoveryOptions = SkillSourceOptions;

export interface CliSkillRecord {
  readonly name: string;
  readonly description: string;
  readonly scope: SkillSource['scope'];
  readonly sourceLabel: string;
  readonly source: string;
  readonly path: string;
}

export function skillListRecord(entry: SourcedSkill): CliSkillRecord {
  return {
    name: entry.skill.name,
    description: entry.skill.description,
    scope: entry.source.scope,
    sourceLabel: entry.source.label ?? entry.source.scope,
    source: entry.source.path,
    path: entry.skill.path,
  };
}

export async function readCliSkills(
  context: Pick<CliContext, 'cwd' | 'resourcesPath'>,
  options: CliSkillDiscoveryOptions = {},
): Promise<DiscoverSkillSourcesResult> {
  return discoverSkillSources(defaultSkillSources(context, options));
}

export async function readCliRuntimeSkills(): Promise<DiscoverSkillSourcesResult> {
  return discoverSkillSources(listRuntimeSkillSources());
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
