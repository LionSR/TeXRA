import * as path from 'node:path';

import type { ActiveSkillSourceScope, InstalledPlugin } from '@shared/schemas';

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
 * `texra.skills.disabledSources` and the active-skills snapshot cannot drift.
 * A `source` tier keeps its roots in registration order; the `name` tier
 * pools its roots and orders their skills by directory name, so bundled
 * skills read the same whether one directory or several ship them.
 *
 * Installed plugins sit right below the user's own skills and carry the
 * `user` scope: installing one is a per-user act like writing
 * `~/.texra/skills`, so the user source switch governs both, and a skill the
 * user writes by hand still shadows a plugin's. They rank above interop
 * imports and bundled skills because an explicit install is a stronger
 * choice than either.
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
  /** The plugins `texra plugin install` recorded, read from settings. */
  readonly plugins: readonly InstalledPlugin[];
  /**
   * The tool plugins the user switched off (`texra.tools.disabled`). A plugin
   * is one on/off unit, so a switched-off plugin's skills are not scanned.
   * Only the switch hides them, not a failed dependency probe: the probe
   * answers per workspace and can be stale, and a plugin's skills are often
   * what tells the user how to install the dependency it probes for.
   */
  readonly disabledPlugins: ReadonlySet<string>;
}

interface SkillRoot {
  readonly path: string;
  readonly label: string;
  readonly required?: true;
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
    // Required: a recorded root that has gone missing is reported, not
    // skipped, until `texra plugin update` or `remove` resolves it. A
    // disabled plugin (`texra plugin disable`) contributes nothing.
    roots: ({ plugins }) =>
      plugins.flatMap((plugin) =>
        (plugin.enabled ? plugin.skills : []).map((skillsPath) => ({
          path: skillsPath,
          label: `plugin ${plugin.name}`,
          required: true as const,
        })),
      ),
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
 * A tool plugin's bundled skills, shipped at `resources/plugins/<id>/skills`,
 * while the plugin is not switched off.
 */
function pluginSkillContribution(pluginId: string): SkillSourceContribution {
  return {
    id: pluginId,
    tier: 'bundled',
    roots: ({ resourcesPath, disabledPlugins }) =>
      disabledPlugins.has(pluginId)
        ? []
        : [
            {
              path: path.join(resourcesPath, 'plugins', pluginId, 'skills'),
              label: 'bundled',
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
