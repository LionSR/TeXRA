import { realpathSync } from 'node:fs';

import { Effect } from 'effect';

import { readInstalledPluginLoad } from '@common/plugins/pluginTrust';

import {
  ACTIVE_SKILLS_SNAPSHOT_MAX_SKILLS,
  type ActiveSkillSourceScope,
  type RawAcceptedSkill,
  type SkillCatalogEntry,
  type SkillDisplayItem,
} from '@shared/schemas';
import { GlobalStateKey, WorkspaceStateKey } from '@shared/state/stateKeys';
import { escapeAttr, escapeText } from '@shared/utils/xmlEscape';
import type { SettingsStores } from '@shared/config/settingsAccess';
import { readSettingFrom } from '@utils/config/platformSettings';
import { isPathWithin } from '@utils/core/pathCore';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';
import { registerExternalRoot } from '@utils/files/externalRoots';
import { safeHomedir } from '@utils/system/platformPaths';

import { issue } from './skillLoader';
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
  catalog: SkillCatalogEntry[];
  skills: RawAcceptedSkill[];
  issues: SkillLoadIssue[];
}

interface DisabledSkills {
  readonly names: readonly string[];
  readonly scopes: readonly ActiveSkillSourceScope[];
  /** The tool plugins switched off, whose bundled skills go with them. */
  readonly plugins: readonly string[];
}

/** Install the process's skill contributions; the default installs none. */
export function installSkillContributions(
  install: SkillContributionsInstall,
): void {
  installed = install;
}

/**
 * Discover the installed contributions folded for one folder, with the
 * installed plugins that load now: the enabled ones the user trusts as they
 * are. Why each other enabled plugin loads nothing is a discovery issue, so
 * every listing names it. `options` replaces the installed options for one
 * call: the CLI's `skills list` flags.
 */
export function discoverRuntimeSkillSources(
  cwd: string,
  stores: SettingsStores,
  options: SkillSourceOptions = installed.options,
) {
  return Effect.gen(function* () {
    const plugins = yield* readInstalledPluginLoad(stores);
    const result = yield* discoverSkillSources(
      foldSkillSources(installed.contributions, {
        cwd,
        // `safeHomedir()` never throws (unlike raw `os.homedir()`, which can
        // raise UV_ENOENT in containers/CI); `/nonexistent` matches the
        // fallback used by other agnostic-zone callers (e.g.
        // `claudeAgentConfig.ts`).
        home: safeHomedir() ?? '/nonexistent',
        resourcesPath: installed.resourcesPath,
        options,
        plugins: plugins.loadable,
      }),
    );
    return {
      skills: result.skills,
      errors: [
        ...plugins.withheld.map((message) =>
          issue('warning', 'invalid_source', message),
        ),
        ...result.errors,
      ],
    } satisfies DiscoverSkillSourcesResult;
  });
}

/**
 * Discover the complete runtime source registry, from the sources of
 * `workspaceRoot` or of the home folder without one. The root is carried as
 * data by the caller that holds it — a run's session workspace, or the host's
 * at the settings surface that asked (#12421).
 */
const discoverRuntimeSkills = (
  workspaceRoot: string | undefined,
  stores: SettingsStores,
) =>
  discoverRuntimeSkillSources(
    workspaceRoot ?? safeHomedir() ?? '/nonexistent',
    stores,
  );

function sourceLabel(source: SkillSource): string {
  return source.label ?? source.scope;
}

/** Whether the source is a tool plugin's that is switched off. */
const pluginOff = (source: SkillSource, disabled: DisabledSkills): boolean =>
  source.plugin !== undefined && disabled.plugins.includes(source.plugin);

function isSkillDisabled(
  { skill, source }: SourcedSkill,
  disabled: DisabledSkills,
): boolean {
  return (
    disabled.names.includes(skill.name) ||
    disabled.scopes.includes(source.scope) ||
    pluginOff(source, disabled)
  );
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
      plugins: yield* readSettingFrom<string[]>(
        stores,
        GlobalStateKey.DISABLED_TOOLS,
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
  entry: SourcedSkill,
  disabled: DisabledSkills,
): SkillDisplayItem {
  const { skill, source } = entry;
  return {
    name: skill.name,
    description: skill.description,
    scope: source.scope,
    label: sourceLabel(source),
    path: skill.path,
    sourcePath: source.path,
    enabled: !isSkillDisabled(entry, disabled),
  };
}

/** Discover the complete inventory for host settings displays. */
export const loadRuntimeSkillDisplay = Effect.fn('skills.runtimeDisplay')(
  function* (workspaceRoot: string | undefined, stores: SettingsStores) {
    const disabled = yield* readDisabledSkills(stores);
    const result = yield* discoverRuntimeSkills(workspaceRoot, stores);
    return {
      // A switched-off plugin's skills are hidden, not listed as disabled:
      // the plugin's switch is their one control.
      skills: result.skills
        .filter(({ source }) => !pluginOff(source, disabled))
        .map((entry) => skillDisplayItem(entry, disabled)),
      issues: result.errors.map(({ message, path }) => ({ message, path })),
    };
  },
);

export function filterDiscoveredSkills(
  result: DiscoverSkillSourcesResult,
  disabled: DisabledSkills,
): DiscoverSkillSourcesResult {
  return {
    skills: result.skills.filter((entry) => !isSkillDisabled(entry, disabled)),
    // Keep discovery issues visible even for disabled sources so users can
    // repair a source before enabling it again.
    errors: result.errors,
  };
}

/**
 * Discover only skills that may be injected or explicitly activated.
 *
 * The catalog and an activation both point the model at a skill's `SKILL.md`
 * and its directory, so each enabled skill outside the workspace is
 * registered as a read-only external root of this project: `read_file` can
 * read the skill and its resources in this project's sessions only, and no
 * tool can write them. A skill inside the
 * workspace is already readable and stays writable like any project file.
 */
export function loadEnabledRuntimeSkills(
  workspaceRoot: string | undefined,
  stores: SettingsStores,
  disabled: DisabledSkills,
) {
  return Effect.gen(function* () {
    const result = yield* discoverRuntimeSkills(workspaceRoot, stores);
    const enabled = filterDiscoveredSkills(result, disabled);
    for (const { skill } of enabled.skills) {
      // Hosts hand the workspace root over already canonical, and a
      // discovered skill directory exists, so its realpath is its physical
      // place. Registration fails closed on a path it cannot verify; that
      // skill then stays unreadable to tools, worth a warning, not a run.
      yield* Effect.try({
        try: () => {
          const directory = realpathSync(skill.baseDir);
          if (
            workspaceRoot !== undefined &&
            isPathWithin(workspaceRoot, directory)
          ) {
            return;
          }
          registerExternalRoot(directory, {
            kind: 'skill',
            writable: false,
            label: `Skill ${skill.name}`,
            project: workspaceRoot,
          });
        },
        catch: ensureError,
      }).pipe(
        Effect.catch((error) =>
          Effect.logWarning(
            `Skill ${skill.name} is not readable by tools: ${toErrorMessage(error)}`,
          ),
        ),
      );
    }
    return enabled;
  });
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
    // The enabled set the hosts list, with every tool plugin's skills
    // whatever its switch: each step lists those of the plugins it pinned,
    // so a switch flipped mid-conversation reaches the prompt.
    const disabled = yield* readDisabledSkills(stores);
    const result = yield* loadEnabledRuntimeSkills(workspaceRoot, stores, {
      ...disabled,
      plugins: [],
    });
    // Discovery orders by source precedence and then skill directory. The
    // bound applies to what a reader lists, after its switch filter, so a
    // switched-off plugin's skills never push an enabled one out: the
    // catalog keeps the first ACTIVE_SKILLS_SNAPSHOT_MAX_SKILLS of core
    // sources and of each plugin, and each step bounds what it lists
    // (`stepInstructions`).
    const kept = new Map<string | undefined, number>();
    const catalog = result.skills.filter(({ source }) => {
      const count = kept.get(source.plugin) ?? 0;
      kept.set(source.plugin, count + 1);
      return count < ACTIVE_SKILLS_SNAPSHOT_MAX_SKILLS;
    });
    return {
      catalog: catalog.map(({ skill, source }) => ({
        plugin: source.plugin ?? null,
        text: `- ${skill.name}: ${skill.description}\n  Source: ${sourceLabel(source)}\n  Path: ${skill.path}`,
      })),
      // The snapshot names the skills of the switches read at open.
      skills: catalog
        .filter(({ source }) => !pluginOff(source, disabled))
        .slice(0, ACTIVE_SKILLS_SNAPSHOT_MAX_SKILLS)
        .map(({ skill, source }) => ({
          name: skill.name,
          description: skill.description,
          source: source.scope,
        })),
      issues: result.errors,
    } satisfies RuntimeSkillCatalogResult;
  },
);
