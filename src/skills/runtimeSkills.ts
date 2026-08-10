import {
  ACTIVE_SKILLS_SNAPSHOT_MAX_SKILLS,
  type RawAcceptedSkill,
} from '@shared/schemas';
import { escapeAttr, escapeText } from '@shared/utils/xmlEscape';

import {
  discoverSkillSources,
  type SkillLoadIssue,
  type SkillSource,
  type SourcedSkill,
} from './loadSkills';

let runtimeSkillSources: readonly SkillSource[] = [];

export interface RuntimeSkillCatalogResult {
  catalog: string;
  skills: RawAcceptedSkill[];
  issues: SkillLoadIssue[];
}

export function setRuntimeSkillSources(sources: readonly SkillSource[]): void {
  runtimeSkillSources = [...sources];
}

export function listRuntimeSkillSources(): readonly SkillSource[] {
  return runtimeSkillSources;
}

function sourceLabel(source: SkillSource): string {
  return source.label ?? source.scope;
}

function formatRuntimeSkillCatalog(skills: readonly SourcedSkill[]): string {
  return skills
    .map(
      ({ skill, source }) =>
        `- ${skill.name}: ${skill.description}\n  Source: ${sourceLabel(source)}\n  Path: ${skill.path}`,
    )
    .join('\n');
}

export function formatRuntimeSkillActivation({
  skill,
  source,
}: SourcedSkill): string {
  const body = escapeText(
    skill.body.replaceAll('${TEXRA_SKILL_DIR}', skill.baseDir),
  );
  return [
    `<skill name="${escapeAttr(skill.name)}">`,
    `<source>${escapeText(sourceLabel(source))}</source>`,
    `<path>${escapeText(skill.path)}</path>`,
    `<skill_directory>${escapeText(skill.baseDir)}</skill_directory>`,
    '<instructions>',
    body,
    '</instructions>',
    '</skill>',
  ].join('\n');
}

export async function loadRuntimeSkillCatalog(): Promise<RuntimeSkillCatalogResult> {
  const sources = listRuntimeSkillSources();
  if (sources.length === 0) return { catalog: '', skills: [], issues: [] };

  const result = await discoverSkillSources(sources);
  // Discovery already orders by source precedence and then skill directory.
  // Bound that accepted set once here, before either prompt or event projection.
  const accepted = result.skills.slice(0, ACTIVE_SKILLS_SNAPSHOT_MAX_SKILLS);
  return {
    catalog: formatRuntimeSkillCatalog(accepted),
    skills: accepted.map(({ skill, source }) => ({
      name: skill.name,
      description: skill.description,
      source: source.scope,
    })),
    issues: result.errors,
  };
}
