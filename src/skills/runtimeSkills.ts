import { Effect } from 'effect';

import {
  readInstalledPluginLoad,
  type InstalledPluginLoad,
} from '@common/plugins/pluginTrust';

import {
  SKILL_CATALOG_MAX_SKILLS,
  type ActiveSkillSourceScope,
  type SkillCatalogEntry,
  type SkillDisplayItem,
} from '@shared/schemas';
import { GlobalStateKey, WorkspaceStateKey } from '@shared/state/stateKeys';
import { escapeAttr, escapeText } from '@shared/utils/xmlEscape';
import type { SettingsStores } from '@shared/config/settingsAccess';
import { readSettingFrom } from '@utils/config/platformSettings';
import { isPathWithin } from '@utils/core/pathCore';
import { canonicalizePath } from '@utils/files/externalRoots';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';
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
 * installed plugins that load (`plugins`, as the caller read them): the
 * enabled ones the user trusts as they are. Why each other enabled plugin
 * loads nothing is a discovery issue, so every listing names it. `options`
 * replaces the installed options for one call: the CLI's `skills list`
 * flags.
 */
export function discoverRuntimeSkillSources(
  cwd: string,
  plugins: InstalledPluginLoad,
  options: SkillSourceOptions = installed.options,
) {
  return Effect.gen(function* () {
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
  plugins: InstalledPluginLoad,
) =>
  discoverRuntimeSkillSources(
    workspaceRoot ?? safeHomedir() ?? '/nonexistent',
    plugins,
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
    const result = yield* discoverRuntimeSkills(
      workspaceRoot,
      yield* readInstalledPluginLoad(stores),
    );
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

/** Discover only skills that may be injected or explicitly activated. */
export function loadEnabledRuntimeSkills(
  workspaceRoot: string | undefined,
  plugins: InstalledPluginLoad,
  disabled: DisabledSkills,
) {
  return Effect.map(discoverRuntimeSkills(workspaceRoot, plugins), (result) =>
    filterDiscoveredSkills(result, disabled),
  );
}

/**
 * One discovered skill as a step lists it: its plugin, name and listing
 * text, and the directory tools may read while the step lists or activated
 * it: its canonical place (the one pipeline external-root lookups use), when
 * outside the workspace, which already holds the rest. One whose place
 * cannot be verified is not granted, which is worth a warning, not a run.
 */
const catalogEntry = (
  workspaceRoot: string | undefined,
  { skill, source }: SourcedSkill,
): Effect.Effect<SkillCatalogEntry> =>
  Effect.try({
    try: () => canonicalizePath(skill.baseDir),
    catch: ensureError,
  }).pipe(
    Effect.map((real) =>
      workspaceRoot !== undefined && isPathWithin(workspaceRoot, real)
        ? null
        : real,
    ),
    Effect.catch((error) =>
      Effect.as(
        Effect.logWarning(
          `Skill ${skill.name} is not readable by tools: ${toErrorMessage(error)}`,
        ),
        null,
      ),
    ),
    Effect.map((directory) => ({
      plugin: source.plugin ?? null,
      name: skill.name,
      text: `- ${skill.name}: ${skill.description}\n  Source: ${sourceLabel(source)}\n  Path: ${skill.path}`,
      directory,
    })),
  );

/**
 * The names of the skills a user activated in `texts`: each
 * `<skill_activation>` block names its skill as
 * {@link formatRuntimeSkillActivation} writes it. The run records the names;
 * each step resolves them against its own catalog.
 */
export const activatedSkillNames = (texts: readonly string[]): string[] => [
  ...new Set(
    texts.flatMap((text) =>
      [
        ...text.matchAll(/<skill_activation>[\s\S]*?<skill name="([^"]+)">/g),
      ].map(([, name]) => name),
    ),
  ),
];

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
  function* (run: {
    /** The run's workspace root; undefined with no folder open. */
    readonly workspacePath: string | undefined;
    /** The run's setting slots, which hold its disabled-skill lists. */
    readonly settings: SettingsStores;
    /** The installed plugins the step accepted. */
    readonly plugins: InstalledPluginLoad;
  }) {
    // The enabled set the hosts list, with every tool plugin's skills
    // whatever its switch: the step lists those of the plugins it pinned.
    const disabled = yield* readDisabledSkills(run.settings);
    const plugins = run.plugins;
    const result = yield* loadEnabledRuntimeSkills(run.workspacePath, plugins, {
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
      return count < SKILL_CATALOG_MAX_SKILLS;
    });
    return {
      catalog: yield* Effect.forEach(catalog, (entry) =>
        catalogEntry(run.workspacePath, entry),
      ),
      issues: result.errors,
    } satisfies RuntimeSkillCatalogResult;
  },
);
