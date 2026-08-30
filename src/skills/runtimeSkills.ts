import {
  ACTIVE_SKILLS_SNAPSHOT_MAX_SKILLS,
  type ActiveSkillSourceScope,
  type RawAcceptedSkill,
  type SkillDisplayItem,
} from '@shared/schemas';
import type { SettingHost } from '@shared/schemas';
import { WorkspaceStateKey } from '@shared/state/stateKeys';
import { escapeAttr, escapeText } from '@shared/utils/xmlEscape';
import { readPlatformSetting } from '@utils/config/platformSettings';

import {
  discoverSkillSources,
  type DiscoverSkillSourcesResult,
  type SkillLoadIssue,
  type SkillSource,
  type SourcedSkill,
} from './loadSkills';

let runtimeSkillSources: readonly SkillSource[] = [];
let runtimeSkillHost: SettingHost = 'vscode';

export interface RuntimeSkillCatalogResult {
  catalog: string;
  skills: RawAcceptedSkill[];
  issues: SkillLoadIssue[];
}

interface DisabledSkills {
  readonly names: readonly string[];
  readonly scopes: readonly ActiveSkillSourceScope[];
}

export function setRuntimeSkillSources(
  sources: readonly SkillSource[],
  host: SettingHost = 'vscode',
): void {
  runtimeSkillSources = [...sources];
  runtimeSkillHost = host;
}

/** Discover the complete runtime source registry for settings displays. */
function discoverRuntimeSkills() {
  return discoverSkillSources(runtimeSkillSources);
}

function isSkillDisabled(
  name: string,
  scope: ActiveSkillSourceScope,
  disabled: DisabledSkills,
): boolean {
  return disabled.names.includes(name) || disabled.scopes.includes(scope);
}

function readDisabledSkills(): DisabledSkills {
  return {
    names: readPlatformSetting<string[]>(
      WorkspaceStateKey.DISABLED_SKILLS,
      runtimeSkillHost,
    ),
    scopes: readPlatformSetting<ActiveSkillSourceScope[]>(
      WorkspaceStateKey.DISABLED_SKILL_SOURCES,
      runtimeSkillHost,
    ),
  };
}

function skillDisplayItems(
  skills: readonly SourcedSkill[],
  disabled: DisabledSkills,
): SkillDisplayItem[] {
  return skills.map(({ skill, source }) => ({
    name: skill.name,
    description: skill.description,
    scope: source.scope,
    label: source.label ?? source.scope,
    path: skill.path,
    enabled: !isSkillDisabled(skill.name, source.scope, disabled),
  }));
}

/** Discover the complete inventory for host settings displays. */
export async function loadRuntimeSkillDisplay(
  disabled: DisabledSkills = readDisabledSkills(),
) {
  const result = await discoverRuntimeSkills();
  return {
    skills: skillDisplayItems(result.skills, disabled),
    issues: result.errors.map(({ message, path }) => ({ message, path })),
  };
}

export function filterDiscoveredSkills(
  result: DiscoverSkillSourcesResult,
  disabled: DisabledSkills = readDisabledSkills(),
): DiscoverSkillSourcesResult {
  return {
    skills: result.skills.filter(
      ({ skill, source }) =>
        !isSkillDisabled(skill.name, source.scope, disabled),
    ),
    // Keep discovery issues visible even for disabled sources so users can
    // repair a source before enabling it again.
    errors: result.errors,
  };
}

/** Discover only skills that may be injected or explicitly activated. */
export async function loadEnabledRuntimeSkills() {
  const result = await discoverRuntimeSkills();
  return filterDiscoveredSkills(result);
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
  if (runtimeSkillSources.length === 0) {
    return { catalog: '', skills: [], issues: [] };
  }

  const result = await loadEnabledRuntimeSkills();
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
