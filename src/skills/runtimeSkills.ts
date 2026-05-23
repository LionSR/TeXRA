import type { AgentTrace } from '@agent/trace';

import {
  discoverSkillSources,
  type SkillLoadIssue,
  type SkillSource,
  type SourcedSkill,
} from './loadSkills';

const runtimeSkillSources: SkillSource[] = [];

export function setRuntimeSkillSources(sources: readonly SkillSource[]): void {
  runtimeSkillSources.length = 0;
  runtimeSkillSources.push(...sources.map((source) => ({ ...source })));
}

export function listRuntimeSkillSources(): SkillSource[] {
  return runtimeSkillSources.map((source) => ({ ...source }));
}

export function clearRuntimeSkillSources(): void {
  runtimeSkillSources.length = 0;
}

function formatSkillIssue(issue: SkillLoadIssue): string {
  const location = issue.path ? ` (${issue.path})` : '';
  return `${issue.severity}: ${issue.message}${location}`;
}

export function formatRuntimeSkillCatalog(
  skills: readonly SourcedSkill[],
): string {
  return skills
    .map(({ skill, source }) => {
      const sourceLabel = source.label ?? source.scope;
      return `- ${skill.name}: ${skill.description}\n  Source: ${sourceLabel}\n  Path: ${skill.path}`;
    })
    .join('\n');
}

export async function loadRuntimeSkillCatalog(
  logger?: AgentTrace,
): Promise<string> {
  const sources = listRuntimeSkillSources();
  if (sources.length === 0) return '';

  const result = await discoverSkillSources(sources);
  for (const issue of result.errors) {
    logger?.warn(`Skill import ${formatSkillIssue(issue)}`);
  }
  if (result.skills.length === 0) return '';

  return formatRuntimeSkillCatalog(result.skills);
}
