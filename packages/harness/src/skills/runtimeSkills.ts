import { Effect } from 'effect';

import {
  readInstalledPluginLoad,
  type InstalledPluginLoad,
} from '@common/plugins/pluginTrust';

import {
  ACTIVATED_SKILLS_MAX,
  QualifiedSkillNameSchema,
  SKILL_CATALOG_MAX_SKILLS,
  type ActiveSkillSourceScope,
  type SkillCatalogEntry,
  type SkillDisplayIssue,
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
 * The roots one skill read answers for: the workspace whose project skills
 * it finds (the home folder without one), the storage root whose `skills/`
 * holds the user's own, and the setting slots that switch skills, sources
 * and plugins off. A session's `WorkspaceRoots` is one.
 */
export type SkillRoots = SettingsStores & {
  readonly workspace: string | undefined;
  readonly storageRoot: string;
};

/**
 * Discover the installed contributions folded for one workspace, with the
 * installed plugins that load (`plugins`, as the caller read them): the
 * enabled ones the user trusts as they are. Why each other enabled plugin
 * loads nothing is a discovery issue, so every listing names it. `options`
 * replaces the installed options for one call: the CLI's `skills list`
 * flags.
 */
function discoverRuntimeSkills(
  roots: Pick<SkillRoots, 'workspace' | 'storageRoot'>,
  plugins: InstalledPluginLoad,
  options: SkillSourceOptions = installed.options,
) {
  // `safeHomedir()` never throws (unlike raw `os.homedir()`, which can raise
  // UV_ENOENT in containers/CI); `/nonexistent` matches the fallback used by
  // other agnostic-zone callers (e.g. `claudeAgentConfig.ts`).
  const home = safeHomedir() ?? '/nonexistent';
  return Effect.gen(function* () {
    const result = yield* discoverSkillSources(
      foldSkillSources(installed.contributions, {
        cwd: roots.workspace ?? home,
        home,
        storageRoot: roots.storageRoot,
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
function readDisabledSkills(stores: SettingsStores) {
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

/** One discovered skill projected for a host display. */
function skillDisplayItem(
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

/** Discover only skills that may be injected or explicitly activated. */
function loadEnabledRuntimeSkills(
  roots: Pick<SkillRoots, 'workspace' | 'storageRoot'>,
  plugins: InstalledPluginLoad,
  disabled: DisabledSkills,
  options?: SkillSourceOptions,
) {
  return Effect.map(
    discoverRuntimeSkills(roots, plugins, options),
    (result): DiscoverSkillSourcesResult => ({
      skills: result.skills.filter(
        (entry) => !isSkillDisabled(entry, disabled),
      ),
      // Keep discovery issues visible even for disabled sources so users
      // can repair a source before enabling it again.
      errors: result.errors,
    }),
  );
}

/** One skill a person may activate: its display row, and the activation
 *  block a message carries to select it. */
export interface EnabledSkill {
  readonly display: SkillDisplayItem;
  readonly activation: string;
}

/**
 * The skills the hosts list and activate, read for one session's roots:
 * project skills under its workspace, the user's under its storage root,
 * installed plugins' as they load now, and the bundled ones the host
 * installed. Every read answers with the discovery issues beside the skills.
 */
export const Skills = {
  /**
   * The complete inventory a settings page lists, each skill marked enabled
   * or not. A switched-off plugin's skills are hidden, not listed as
   * disabled: the plugin's switch is their one control.
   */
  display: Effect.fn('Skills.display')(function* (roots: SkillRoots) {
    const disabled = yield* readDisabledSkills(roots);
    const result = yield* discoverRuntimeSkills(
      roots,
      yield* readInstalledPluginLoad(roots),
    );
    return {
      skills: result.skills
        .filter(({ source }) => !pluginOff(source, disabled))
        .map((entry) => skillDisplayItem(entry, disabled)),
      issues: result.errors.map(({ message, path }): SkillDisplayIssue => ({
        message,
        path,
      })),
    };
  }),
  /**
   * The skills agents are offered: every enabled one, in precedence order,
   * with each discovery issue in full. `options` replaces the host's source
   * options for one read (the CLI's `skills list` flags).
   */
  enabled: Effect.fn('Skills.enabled')(function* (
    roots: SkillRoots,
    options?: SkillSourceOptions,
  ) {
    const disabled = yield* readDisabledSkills(roots);
    const result = yield* loadEnabledRuntimeSkills(
      roots,
      yield* readInstalledPluginLoad(roots),
      disabled,
      options,
    );
    return {
      skills: result.skills.map((entry): EnabledSkill => ({
        display: skillDisplayItem(entry, disabled),
        activation: formatRuntimeSkillActivation(entry),
      })),
      issues: result.errors,
    };
  }),
};

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
 * {@link formatRuntimeSkillActivation} writes it. Only a well-formed skill
 * name counts, and only the last `ACTIVATED_SKILLS_MAX`; what a run records
 * of them is what a step's catalog resolves.
 */
export const activatedSkillNames = (texts: readonly string[]): string[] =>
  [
    ...new Set(
      texts.flatMap((text) =>
        [
          ...text.matchAll(/<skill_activation>[\s\S]*?<skill name="([^"]+)">/g),
        ].flatMap(([, name]) =>
          QualifiedSkillNameSchema.safeParse(name).success ? [name] : [],
        ),
      ),
    ),
  ].slice(-ACTIVATED_SKILLS_MAX);

/**
 * The block a message carries to activate one skill: the instruction to
 * use it, and its body with `${TEXRA_SKILL_DIR}` resolved. Its
 * `<skill name>` is what {@link activatedSkillNames} reads back.
 */
function formatRuntimeSkillActivation({ skill, source }: SourcedSkill): string {
  const body = escapeText(
    skill.body.replaceAll('${TEXRA_SKILL_DIR}', skill.baseDir),
  );
  return [
    '<skill_activation>',
    `The user selected the ${escapeText(skill.name)} skill. Use these instructions for the next substantive user request. Resolve relative file references against the skill_directory.`,
    `<skill name="${escapeAttr(skill.name)}">`,
    `<source>${escapeText(sourceLabel(source))}</source>`,
    `<path>${escapeText(skill.path)}</path>`,
    `<skill_directory>${escapeText(skill.baseDir)}</skill_directory>`,
    '<instructions>',
    body,
    '</instructions>',
    '</skill>',
    '</skill_activation>',
  ].join('\n');
}

export const loadRuntimeSkillCatalog = Effect.fn('skills.runtimeCatalog')(
  function* (run: {
    /** The run's session roots: its workspace (undefined with no folder
     *  open), its storage root, and the slots holding its disabled-skill
     *  lists. */
    readonly roots: SkillRoots;
    /** The installed plugins the step accepted. */
    readonly plugins: InstalledPluginLoad;
    /** Skills to resolve by name from everything discovery enables, past
     *  the listing's bound: the activated ones, or a resumed step's
     *  recorded listing. */
    readonly named?: readonly string[];
  }) {
    // The enabled set the hosts list, with every tool plugin's skills
    // whatever its switch: the step lists those of the plugins it pinned.
    const disabled = yield* readDisabledSkills(run.roots);
    const result = yield* loadEnabledRuntimeSkills(run.roots, run.plugins, {
      ...disabled,
      plugins: [],
    });
    // Discovery orders by source precedence and then skill directory. The
    // bound applies to what a reader lists, after its switch filter, so a
    // switched-off plugin's skills never push an enabled one out: the
    // catalog keeps the first SKILL_CATALOG_MAX_SKILLS of core sources and
    // of each plugin, and each step bounds what it lists (`openStep`).
    const kept = new Map<string | undefined, number>();
    const catalog = result.skills.filter(({ source }) => {
      const count = kept.get(source.plugin) ?? 0;
      kept.set(source.plugin, count + 1);
      return count < SKILL_CATALOG_MAX_SKILLS;
    });
    const named = new Set(run.named);
    return {
      catalog: yield* Effect.forEach(catalog, (entry) =>
        catalogEntry(run.roots.workspace, entry),
      ),
      named: yield* Effect.forEach(
        result.skills.filter(({ skill }) => named.has(skill.name)),
        (entry) => catalogEntry(run.roots.workspace, entry),
      ),
      issues: result.errors,
    };
  },
);
