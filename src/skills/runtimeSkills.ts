import { Effect } from 'effect';

import {
  ACTIVE_SKILLS_SNAPSHOT_MAX_SKILLS,
  type ActiveSkillSourceScope,
  type RawAcceptedSkill,
  type SkillDisplayItem,
} from '@shared/schemas';
import { WorkspaceStateKey } from '@shared/state/stateKeys';
import { escapeAttr, escapeText } from '@shared/utils/xmlEscape';
import type { SettingsStores } from '@shared/config/settingsAccess';
import { readSettingFrom } from '@utils/config/platformSettings';
import { safeHomedir } from '@utils/system/platformPaths';

import {
  discoverSkillSources,
  type DiscoverSkillSourcesResult,
  type SkillLoadIssue,
  type SkillSource,
  type SourcedSkill,
} from './loadSkills';

import {
  foldSkillSources,
  type SkillSourceContribution,
  type SkillSourceOptions,
} from './skillSources';

/**
 * The skill contributions a host installed, with its bundled resources tree
 * and its process-wide source options. Only data is fixed here: project and
 * interop sources live under the workspace folder, so they are resolved per
 * call from the calling session's workspace, and a desktop with several
 * papers open discovers each run's project skills in that run's own folder.
 */
interface SkillContributionsInstall {
  readonly resourcesPath: string;
  readonly options: SkillSourceOptions;
  readonly contributions: readonly SkillSourceContribution[];
}

let installed: SkillContributionsInstall = {
  resourcesPath: '',
  options: {},
  contributions: [],
};

interface RuntimeSkillCatalogResult {
  catalog: string;
  skills: RawAcceptedSkill[];
  issues: SkillLoadIssue[];
}

interface DisabledSkills {
  readonly names: readonly string[];
  readonly scopes: readonly ActiveSkillSourceScope[];
}

/** Install the process's skill contributions; the default installs none. */
export function installSkillContributions(
  install: SkillContributionsInstall,
): void {
  installed = install;
}

/**
 * The installed contributions folded for one folder. `options` replaces the
 * installed options for one call: the CLI's `skills list` flags.
 */
export function runtimeSkillSources(
  cwd: string,
  options: SkillSourceOptions = installed.options,
) {
  return foldSkillSources(installed.contributions, {
    cwd,
    // `safeHomedir()` never throws (unlike raw `os.homedir()`, which can
    // raise UV_ENOENT in containers/CI); `/nonexistent` matches the fallback
    // used by other agnostic-zone callers (e.g. `claudeAgentConfig.ts`).
    home: safeHomedir() ?? '/nonexistent',
    resourcesPath: installed.resourcesPath,
    options,
  });
}

/**
 * Discover the complete runtime source registry, from the sources of
 * `workspaceRoot` or of the home folder without one. The root is carried as
 * data by the caller that holds it — a run's session workspace, or the host's
 * at the settings surface that asked (#12421).
 */
function discoverRuntimeSkills(workspaceRoot: string | undefined) {
  return discoverSkillSources(
    runtimeSkillSources(workspaceRoot ?? safeHomedir() ?? '/nonexistent'),
  );
}

function sourceLabel(source: SkillSource): string {
  return source.label ?? source.scope;
}

function isSkillDisabled(
  name: string,
  scope: ActiveSkillSourceScope,
  disabled: DisabledSkills,
): boolean {
  return disabled.names.includes(name) || disabled.scopes.includes(scope);
}

/**
 * The disabled names and scopes of one workspace, read from the slots the
 * caller holds: a host settings surface passes its session roots, a run passes
 * the roots its prompt is being built for, so the answer is that project's
 * rather than the calling context's.
 */
export function readDisabledSkills(stores: SettingsStores) {
  return Effect.gen(function* () {
    return {
      names: yield* readSettingFrom<string[]>(
        stores,
        WorkspaceStateKey.DISABLED_SKILLS,
      ),
      scopes: yield* readSettingFrom<ActiveSkillSourceScope[]>(
        stores,
        WorkspaceStateKey.DISABLED_SKILL_SOURCES,
      ),
    };
  });
}

/**
 * One discovered skill projected for a host display. Every host renders this
 * shape: the settings tabs from {@link loadRuntimeSkillDisplay}, and the CLI's
 * `skills list` per discovered entry.
 */
export function skillDisplayItem(
  { skill, source }: SourcedSkill,
  disabled: DisabledSkills,
): SkillDisplayItem {
  return {
    name: skill.name,
    description: skill.description,
    scope: source.scope,
    label: sourceLabel(source),
    path: skill.path,
    sourcePath: source.path,
    enabled: !isSkillDisabled(skill.name, source.scope, disabled),
  };
}

/** Discover the complete inventory for host settings displays. */
export const loadRuntimeSkillDisplay = Effect.fn('skills.runtimeDisplay')(
  function* (workspaceRoot: string | undefined, stores: SettingsStores) {
    const disabled = yield* readDisabledSkills(stores);
    const result = yield* discoverRuntimeSkills(workspaceRoot);
    return {
      skills: result.skills.map((entry) => skillDisplayItem(entry, disabled)),
      issues: result.errors.map(({ message, path }) => ({ message, path })),
    };
  },
);

export function filterDiscoveredSkills(
  result: DiscoverSkillSourcesResult,
  disabled: DisabledSkills,
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
export function loadEnabledRuntimeSkills(
  workspaceRoot: string | undefined,
  stores: SettingsStores,
) {
  return Effect.gen(function* () {
    const result = yield* discoverRuntimeSkills(workspaceRoot);
    return filterDiscoveredSkills(result, yield* readDisabledSkills(stores));
  });
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

export const loadRuntimeSkillCatalog = Effect.fn('skills.runtimeCatalog')(
  function* (workspaceRoot: string | undefined, stores: SettingsStores) {
    // The same enabled set the hosts list, projected for the prompt: an empty
    // source registry discovers nothing and formats to the empty catalog, so
    // no separate zero-source arm decides that answer.
    const result = yield* loadEnabledRuntimeSkills(workspaceRoot, stores);
    // Discovery already orders by source precedence and then skill directory.
    // Bound that accepted set once here, before either prompt or event
    // projection.
    const accepted = result.skills.slice(0, ACTIVE_SKILLS_SNAPSHOT_MAX_SKILLS);
    return {
      catalog: formatRuntimeSkillCatalog(accepted),
      skills: accepted.map(({ skill, source }) => ({
        name: skill.name,
        description: skill.description,
        source: source.scope,
      })),
      issues: result.errors,
    } satisfies RuntimeSkillCatalogResult;
  },
);
