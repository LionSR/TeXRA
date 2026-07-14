import { escapeAttr, escapeText } from '@shared/utils/xmlEscape';

import {
  discoverSkillSources,
  type SkillLoadIssue,
  type SkillSource,
  type SourcedSkill,
} from './loadSkills';

const runtimeSkillSources: SkillSource[] = [];

export interface RuntimeSkillCatalogResult {
  catalog: string;
  issues: SkillLoadIssue[];
}

export type { SkillLoadIssue } from './loadSkills';

export function setRuntimeSkillSources(sources: readonly SkillSource[]): void {
  runtimeSkillSources.length = 0;
  runtimeSkillSources.push(...sources.map((source) => ({ ...source })));
}

export function listRuntimeSkillSources(): SkillSource[] {
  return runtimeSkillSources.map((source) => ({ ...source }));
}

function formatRuntimeSkillCatalog(skills: readonly SourcedSkill[]): string {
  return skills
    .map(({ skill, source }) => {
      const sourceLabel = source.label ?? source.scope;
      return `- ${skill.name}: ${skill.description}\n  Source: ${sourceLabel}\n  Path: ${skill.path}`;
    })
    .join('\n');
}

export function formatRuntimeSkillActivation({
  skill,
  source,
}: SourcedSkill): string {
  const sourceLabel = source.label ?? source.scope;
  const body = escapeText(
    skill.body.replaceAll('${TEXRA_SKILL_DIR}', skill.baseDir),
  );
  return [
    `<skill name="${escapeAttr(skill.name)}">`,
    `<source>${escapeText(sourceLabel)}</source>`,
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
  if (sources.length === 0) return { catalog: '', issues: [] };

  const result = await discoverSkillSources(sources);
  return {
    catalog: formatRuntimeSkillCatalog(result.skills),
    issues: result.errors,
  };
}
