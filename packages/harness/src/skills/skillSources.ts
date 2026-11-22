import * as path from 'node:path';

import type { LoadablePlugin } from '@common/plugins/pluginTrust';
import { bundledPluginSkillsDir } from '@common/storage/storageLayout';

import type { SkillSource, SkillSourceTier } from './loadSkills';

export interface SkillSourceOptions {
  readonly additionalPaths?: readonly string[];
}

/**
 * A process's skill sources (`ProcessLayerOptions.skills`,
 * `Composition.skills`): its bundled resources tree, under which each of its
 * tool plugins ships its bundled skills (`plugins/<id>/skills`), the folder
 * it keeps in each project, and its process-wide source options (the CLI's
 * flags). Discovery reads custom roots, project skills, user skills (the
 * storage root's `skills/`) and the bundled ones in that precedence. A
 * process given none discovers no skills at all.
 */
export interface HostSkillOptions {
  readonly resourcesPath: string;
  /**
   * The folder the host keeps in each project, relative to a session's
   * workspace (TeXRA's `.texra`): its `skills/` holds the project's own
   * skills. Absent, a project has no skills but those a custom root or the
   * other agent tools' folders hold.
   */
  readonly projectDataDirName?: string;
  readonly skillSourceOptions?: SkillSourceOptions;
}

/**
 * The other agent tools' folders whose `skills/` are discovered beside a
 * workspace and the home folder, in the `interop` scope. Discovery always
 * reads them; `skills.disabledSources` lists the scope by default, so a
 * person switches them on from the settings, the same way as any source.
 */
const INTEROP_SKILL_DIRS = Object.freeze([
  '.agents',
  '.claude',
  '.codex',
  '.gemini',
] as const);

/** What one discovery reads its sources from: the host's data, the
 *  session's folders and the installed plugins that load. */
export interface SkillSourceCall {
  readonly resourcesPath: string;
  readonly projectDataDirName: string | undefined;
  /** The process's tool plugins, each of which may ship bundled skills. */
  readonly pluginIds: readonly string[];
  readonly options: SkillSourceOptions;
  /** The session's workspace; none for a session without one, which has
   *  no project skills (its home is not a project). */
  readonly cwd: string | undefined;
  readonly home: string;
  /** The storage root the host opened; its `skills/` holds the user's own. */
  readonly storageRoot: string;
  /** The installed plugins that load: enabled, and trusted as they are. */
  readonly plugins: readonly LoadablePlugin[];
}

function interopRoots(base: string, scopeLabel: string): SkillSource[] {
  return INTEROP_SKILL_DIRS.map((dir) => ({
    scope: 'interop',
    path: path.join(base, dir, 'skills'),
    label: `${dir} ${scopeLabel}`,
  }));
}

/**
 * The tiers one discovery scans, in precedence order: custom roots, the
 * project's skills, the other agent tools' project folders, the user's own
 * skills, the installed plugins', the other agent tools' home folders, and
 * the bundled ones.
 *
 * Installed plugins sit right below the user's own skills and carry the
 * `user` scope: installing one is a per-user act like writing to the storage
 * root's `skills/`, so the user source switch governs both. Their skills and
 * commands are named `<plugin>:<name>`, so they never shadow, or are shadowed
 * by, a skill of another source.
 *
 * The bundled tier pools the resources tree's skills with each tool plugin's
 * (`resources/plugins/<id>/skills`; a plugin that ships none has no such
 * directory, which reads as no skills), so bundled skills read the same
 * whether one directory or several ship them. A tool plugin's are tagged with
 * the plugin: its switch (`tools.disabled`) gates them, and a run's step lists
 * them while it pins the plugin. Only the switch hides them, not a failed
 * dependency probe: the probe answers per workspace and can be stale, and a
 * plugin's skills are often what tells the user how to install the dependency
 * it probes for.
 *
 * A path seen twice keeps its first occurrence (and becomes required if any
 * occurrence is), so an explicitly requested project skills root still
 * absorbs the project root.
 */
export function skillTiers(call: SkillSourceCall): SkillSourceTier[] {
  const { cwd, home, projectDataDirName, resourcesPath } = call;
  const tiers: SkillSourceTier[] = [
    {
      // A relative path with no workspace resolves from the home directory.
      sources: (call.options.additionalPaths ?? []).map((candidate) => ({
        scope: 'custom',
        path: path.resolve(cwd ?? home, candidate),
        label: 'custom',
        required: true,
      })),
    },
    {
      sources:
        cwd === undefined || projectDataDirName === undefined
          ? []
          : [
              {
                scope: 'project',
                path: path.join(cwd, projectDataDirName, 'skills'),
                label: 'project',
              },
            ],
    },
    { sources: cwd === undefined ? [] : interopRoots(cwd, 'project') },
    {
      sources: [
        {
          scope: 'user',
          path: path.join(call.storageRoot, 'skills'),
          label: 'user',
        },
      ],
    },
    {
      // Each skill root and command file the plugin declares, read when it
      // loaded; a root that has gone missing since is reported, not skipped.
      sources: call.plugins.flatMap(({ record, plugin }) => {
        const source = (entry: string, command: boolean): SkillSource => ({
          scope: 'user',
          path: path.join(record.path, entry),
          label: `plugin ${record.name}`,
          required: true,
          plugin: { kind: 'installed', name: record.name, command },
        });
        return [
          ...plugin.skills.map((skills) => source(skills, false)),
          ...plugin.commands.map((command) => source(command, true)),
        ];
      }),
    },
    { sources: interopRoots(home, 'user') },
    {
      pooled: true,
      sources: [
        {
          scope: 'bundled',
          path: path.join(resourcesPath, 'skills'),
          label: 'bundled',
        },
        ...call.pluginIds.map((pluginId): SkillSource => ({
          scope: 'bundled',
          path: bundledPluginSkillsDir(resourcesPath, pluginId),
          label: 'bundled',
          plugin: { kind: 'tool', id: pluginId },
        })),
      ],
    },
  ];
  const seen = new Map<string, { tier: number; source: SkillSource }>();
  tiers.forEach((tier, index) => {
    for (const source of tier.sources) {
      const key = path.resolve(source.path);
      const existing = seen.get(key);
      if (existing === undefined)
        seen.set(key, { tier: index, source: { ...source, path: key } });
      else if (source.required === true)
        existing.source = { ...existing.source, required: true };
    }
  });
  const entries = [...seen.values()];
  return tiers.flatMap((tier, index) => {
    const sources = entries
      .filter((entry) => entry.tier === index)
      .map((entry) => entry.source);
    return sources.length === 0 ? [] : [{ ...tier, sources }];
  });
}
