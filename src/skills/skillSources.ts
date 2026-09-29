import * as path from 'node:path';

import {
  installedPluginId,
  type LoadablePlugin,
} from '@common/plugins/pluginTrust';
import type { ActiveSkillSourceScope } from '@shared/schemas';

import type { SkillSource, SkillSourceTier } from './loadSkills';

export interface SkillSourceOptions {
  readonly includeInterop?: boolean;
  readonly additionalPaths?: readonly string[];
}

export const INTEROP_SKILL_DIRS = [
  '.agents',
  '.claude',
  '.codex',
  '.gemini',
] as const;

/**
 * The skill tiers in precedence order. A tier fixes the persisted scope its
 * sources carry, so a contribution never picks its own scope: a tool plugin
 * can only land in `bundled`, and the `ActiveSkillSourceScope` vocabulary in
 * `texra.skills.disabledSources` cannot drift.
 * A `source` tier keeps its roots in registration order; the `name` tier
 * pools its roots and orders their skills by directory name, so bundled
 * skills read the same whether one directory or several ship them.
 *
 * Installed plugins sit right below the user's own skills and carry the
 * `user` scope: installing one is a per-user act like writing
 * `~/.texra/skills`, so the user source switch governs both. Their skills
 * and commands are named `<plugin>:<name>`, so they never shadow, or are
 * shadowed by, a skill of another source.
 */
const SKILL_TIERS = [
  { id: 'custom', scope: 'custom', order: 'source' },
  { id: 'project', scope: 'project', order: 'source' },
  { id: 'interop-project', scope: 'interop', order: 'source' },
  { id: 'user', scope: 'user', order: 'source' },
  { id: 'plugin', scope: 'user', order: 'source' },
  { id: 'interop-user', scope: 'interop', order: 'source' },
  { id: 'bundled', scope: 'bundled', order: 'name' },
] as const satisfies readonly {
  id: string;
  scope: ActiveSkillSourceScope;
  order: SkillSourceTier['order'];
}[];

type SkillTierId = (typeof SKILL_TIERS)[number]['id'];

/** What one discovery asks of the contributions: its folder and flags. */
interface SkillSourceCall {
  readonly cwd: string;
  readonly home: string;
  readonly resourcesPath: string;
  readonly options: SkillSourceOptions;
  /** The installed plugins that load: enabled, and trusted as they are. */
  readonly plugins: readonly LoadablePlugin[];
}

interface SkillRoot {
  readonly path: string;
  readonly label: string;
  readonly required?: true;
  /** The plugin that ships these skills: a tool plugin's id, or an
   *  installed plugin's (`plugin:<name>`). */
  readonly plugin?: string;
  /** The installed plugin whose name prefixes the skills' names. */
  readonly namespace?: string;
  /** `path` is one command file (`commands/<name>.md`), not a skill root. */
  readonly command?: true;
}

/**
 * One producer of skill roots: a stable id, the tier it lands in, and its
 * roots as a function of the call, so project sources follow each session's
 * workspace and the CLI's per-command flags.
 */
export interface SkillSourceContribution {
  readonly id: string;
  readonly tier: SkillTierId;
  readonly roots: (call: SkillSourceCall) => readonly SkillRoot[];
}

function interopRoots(base: string, scopeLabel: string): SkillRoot[] {
  return INTEROP_SKILL_DIRS.map((dir) => ({
    path: path.join(base, dir, 'skills'),
    label: `${dir} ${scopeLabel}`,
  }));
}

const CORE_SKILL_CONTRIBUTIONS: readonly SkillSourceContribution[] = [
  {
    id: 'core:custom',
    tier: 'custom',
    roots: ({ cwd, options }) =>
      (options.additionalPaths ?? []).map((candidate) => ({
        path: path.resolve(cwd, candidate),
        label: 'custom',
        required: true,
      })),
  },
  {
    id: 'core:project',
    tier: 'project',
    roots: ({ cwd }) => [
      { path: path.join(cwd, '.texra', 'skills'), label: 'project' },
    ],
  },
  {
    id: 'core:interop-project',
    tier: 'interop-project',
    roots: ({ cwd, options }) =>
      options.includeInterop === true ? interopRoots(cwd, 'project') : [],
  },
  {
    id: 'core:user',
    tier: 'user',
    roots: ({ home }) => [
      { path: path.join(home, '.texra', 'skills'), label: 'user' },
    ],
  },
  {
    id: 'core:plugins',
    tier: 'plugin',
    // Each skill root and command file the plugin declares, read when it
    // loaded; a root that has gone missing since is reported, not skipped.
    roots: ({ plugins }) =>
      plugins.flatMap(({ record, plugin }) => {
        const root = {
          label: `plugin ${record.name}`,
          required: true as const,
          plugin: installedPluginId(record.name),
          namespace: record.name,
        };
        return [
          ...plugin.skills.map((skills) => ({
            ...root,
            path: path.join(record.path, skills),
          })),
          ...plugin.commands.map((command) => ({
            ...root,
            path: path.join(record.path, command),
            command: true as const,
          })),
        ];
      }),
  },
  {
    id: 'core:interop-user',
    tier: 'interop-user',
    roots: ({ home, options }) =>
      options.includeInterop === true ? interopRoots(home, 'user') : [],
  },
  {
    id: 'core:bundled',
    tier: 'bundled',
    roots: ({ resourcesPath }) => [
      { path: path.join(resourcesPath, 'skills'), label: 'bundled' },
    ],
  },
];

/**
 * A tool plugin's bundled skills, shipped at `resources/plugins/<id>/skills`
 * and tagged with the plugin. A plugin is one on/off unit, so its switch
 * (`texra.tools.disabled`) gates them (`readDisabledSkills`), and a run's
 * step lists them while it pins the plugin. Only the switch hides them, not
 * a failed dependency probe: the probe answers per workspace and can be
 * stale, and a plugin's skills are often what tells the user how to install
 * the dependency it probes for.
 */
function pluginSkillContribution(pluginId: string): SkillSourceContribution {
  return {
    id: pluginId,
    tier: 'bundled',
    roots: ({ resourcesPath }) => [
      {
        path: path.join(resourcesPath, 'plugins', pluginId, 'skills'),
        label: 'bundled',
        plugin: pluginId,
      },
    ],
  };
}

/**
 * The contributions a host installs: the core sources, then the bundled
 * skills of each tool plugin that ships them. The ids come in as strings from
 * the host bootstrap, which reads the tool plugin manifest, so `@skills` keeps
 * no edge to `@tools`.
 */
export function hostSkillContributions(
  skillPluginIds: readonly string[],
): readonly SkillSourceContribution[] {
  return [
    ...CORE_SKILL_CONTRIBUTIONS,
    ...skillPluginIds.map(pluginSkillContribution),
  ];
}

/**
 * Fold contributions into the tiers one discovery scans. Contributions are
 * stable-sorted by tier and flattened with the tier's scope stamped on; a
 * path seen twice keeps its first occurrence (and becomes required if any
 * occurrence is), so a `--skills .texra/skills` root still absorbs the
 * project root. Contribution ids are unique; a repeated id is a wiring
 * defect and throws, so the id stays a checked key for the display and
 * toggle consumers that will read it.
 */
export function foldSkillSources(
  contributions: readonly SkillSourceContribution[],
  call: SkillSourceCall,
): SkillSourceTier[] {
  const ids = new Set<string>();
  for (const { id } of contributions) {
    if (ids.has(id)) {
      throw new Error(`Duplicate skill source contribution id: ${id}`);
    }
    ids.add(id);
  }
  const seen = new Map<string, { tier: number; source: SkillSource }>();
  SKILL_TIERS.forEach((tier, index) => {
    for (const contribution of contributions) {
      if (contribution.tier !== tier.id) continue;
      for (const root of contribution.roots(call)) {
        const key = path.resolve(root.path);
        const existing = seen.get(key);
        if (existing) {
          if (root.required === true) {
            existing.source = { ...existing.source, required: true };
          }
          continue;
        }
        seen.set(key, {
          tier: index,
          source: {
            scope: tier.scope,
            path: key,
            label: root.label,
            ...(root.required === true ? { required: true } : {}),
            ...(root.plugin === undefined ? {} : { plugin: root.plugin }),
            ...(root.namespace === undefined
              ? {}
              : { namespace: root.namespace }),
            ...(root.command === undefined ? {} : { command: root.command }),
          },
        });
      }
    }
  });
  const entries = [...seen.values()];
  return SKILL_TIERS.flatMap((tier, index) => {
    const sources = entries
      .filter((entry) => entry.tier === index)
      .map((entry) => entry.source);
    return sources.length === 0 ? [] : [{ order: tier.order, sources }];
  });
}
