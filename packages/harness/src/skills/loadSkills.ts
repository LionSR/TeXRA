// Standard library imports
import * as path from 'node:path';

// Third-party imports
import { Effect, FileSystem } from 'effect';

// Local imports - common
import { SKILL_FILE_NAME, type ActiveSkillSourceScope } from '@shared/schemas';
import { meansAbsent } from '@utils/files/fsEntryExists';

// Local imports - skill parsing
import {
  type SkillLoadIssue,
  issue,
  loadCommandFile,
  loadSkillDirectory,
} from './skillLoader';
import type { Skill } from './SkillSchema';

interface DiscoveredSkill {
  skill: Skill;
  /** Canonical `SKILL.md` path, resolved while the skill was discovered. */
  realPath: string;
  /** The skill's directory name under its root, the scan's sort key. */
  entryName: string;
}

interface SkillRootScan {
  skills: DiscoveredSkill[];
  errors: SkillLoadIssue[];
}

/** Scope vocabulary comes from the shared wire-contract enum
 *  (`ActiveSkillSourceScope`) so the loader and the persisted
 *  disabled-source setting can't drift. */
export interface SkillSource {
  readonly scope: ActiveSkillSourceScope;
  readonly path: string;
  /** What a listing shows the source as. */
  readonly label: string;
  readonly required?: boolean;
  /** The plugin that ships these skills, absent for a core source. */
  readonly plugin?: SkillSourcePlugin;
}

/**
 * A tool plugin, whose switch (by `id`) gates its skills, or an installed
 * plugin, whose skills are named `<name>:<skill>` and whose switch is
 * `plugin:<name>`. An installed plugin's source may be one command file
 * (`command`), read as the skill its name names.
 */
export type SkillSourcePlugin =
  | { readonly kind: 'tool'; readonly id: string }
  | {
      readonly kind: 'installed';
      readonly name: string;
      readonly command: boolean;
    };

/** Whether `source.path` is one plugin command file, not a skill root. */
const isCommandFile = ({ plugin }: SkillSource): boolean =>
  plugin?.kind === 'installed' && plugin.command;

/**
 * One precedence tier of sources. A tier takes its roots' skills in root
 * order (the roots are read at once); a `pooled` tier pools its roots and
 * orders their skills by directory name, the order one root holding all of
 * them would give.
 */
export interface SkillSourceTier {
  readonly pooled?: boolean;
  readonly sources: readonly SkillSource[];
}

export interface SourcedSkill {
  skill: Skill;
  source: SkillSource;
}

export interface DiscoverSkillSourcesResult {
  skills: SourcedSkill[];
  errors: SkillLoadIssue[];
}

function dupNameIssue(name: string, path: string): SkillLoadIssue {
  return issue('warning', `Skipping duplicate skill name "${name}"`, {
    path,
    name,
  });
}

function dupRealpathIssue(
  realPath: string,
  path: string,
  name: string,
): SkillLoadIssue {
  return issue('warning', `Skipping duplicate skill path ${realPath}`, {
    path,
    name,
  });
}

/**
 * Discover one-level `SKILL.md` packages below `root`, in directory-name
 * order; the caller decides between duplicates.
 *
 * Missing roots are treated as empty because user and project skill directories
 * are optional. Per-skill failures are reported and do not abort discovery.
 * A non-directory entry, a symlink to a file included, is not a skill package
 * and is skipped silently.
 */
const scanSkillRoot = Effect.fn('skills.scanSkillRoot')(function* (
  root: string,
): Effect.fn.Return<SkillRootScan, never, FileSystem.FileSystem> {
  const fs = yield* FileSystem.FileSystem;
  const skills: DiscoveredSkill[] = [];
  const errors: SkillLoadIssue[] = [];

  const names: string[] | undefined = yield* fs.readDirectory(root).pipe(
    Effect.catch((error) =>
      Effect.sync(() => {
        if (!meansAbsent(error)) {
          errors.push(
            issue('error', error.message, { path: root, code: 'read_error' }),
          );
        }
        return undefined;
      }),
    ),
  );
  if (names === undefined) return { skills, errors };

  // Each entry resolves and loads in one concurrent pass; its issues are
  // reported afterwards in name order.
  const entries = yield* Effect.forEach(
    names.toSorted((a, b) => a.localeCompare(b)),
    (name) => {
      const skillPath = path.join(root, name, SKILL_FILE_NAME);
      return fs.realPath(skillPath).pipe(
        Effect.flatMap((realSkillPath) =>
          Effect.map(
            loadSkillDirectory(path.join(root, name), name),
            (loaded) => ({
              name,
              skillPath,
              realSkillPath,
              loaded,
              issue: undefined,
            }),
          ),
        ),
        Effect.catch((error) =>
          Effect.succeed({
            name,
            skillPath,
            realSkillPath: undefined,
            loaded: undefined,
            issue: meansAbsent(error)
              ? undefined
              : issue('warning', error.message, {
                  path: skillPath,
                }),
          }),
        ),
      );
    },
    { concurrency: 16 },
  );

  for (const entry of entries) {
    if (entry.issue !== undefined) errors.push(entry.issue);
    const { loaded, realSkillPath } = entry;
    if (loaded === undefined) continue;
    errors.push(...loaded.errors);
    if (!loaded.skill) continue;
    skills.push({
      skill: loaded.skill,
      realPath: realSkillPath,
      entryName: entry.name,
    });
  }

  return { skills, errors };
});

/** One plugin command file, scanned as a root holding the one skill it is. */
const scanCommandFile = Effect.fn('skills.scanCommandFile')(function* (
  file: string,
): Effect.fn.Return<SkillRootScan, never, FileSystem.FileSystem> {
  const loaded = yield* loadCommandFile(file);
  return {
    skills: loaded.skill
      ? [
          {
            skill: loaded.skill,
            realPath: file,
            entryName: path.basename(file),
          },
        ]
      : [],
    errors: loaded.errors,
  };
});

/**
 * Validate a `required` skill source, returning an issue when the path is
 * missing or not a directory. Optional sources skip this check entirely.
 */
function validateRequiredSource(
  source: SkillSource,
): Effect.Effect<SkillLoadIssue | undefined, never, FileSystem.FileSystem> {
  return FileSystem.FileSystem.use((fs) => fs.stat(source.path)).pipe(
    Effect.map((info) =>
      info.type === (isCommandFile(source) ? 'File' : 'Directory')
        ? undefined
        : issue('error', 'Skill source is not a directory', {
            path: source.path,
            code: 'source_error',
          }),
    ),
    Effect.catch((error) => {
      if (meansAbsent(error)) {
        return Effect.succeed(
          issue('error', 'Skill source does not exist', {
            path: source.path,
            code: 'source_error',
          }),
        );
      }
      return Effect.succeed(
        issue('error', error.message, {
          path: source.path,
          code: 'source_error',
        }),
      );
    }),
  );
}

/**
 * Discover skills from tiers of roots in precedence order.
 *
 * A skill name or canonical `SKILL.md` file is accepted only from the first
 * source that provides it, in the tier's order (within one root, the first
 * in directory-name order).
 */
export const discoverSkillSources = Effect.fn('skills.discoverSkillSources')(
  function* (
    tiers: readonly SkillSourceTier[],
  ): Effect.fn.Return<
    DiscoverSkillSourcesResult,
    never,
    FileSystem.FileSystem
  > {
    const skills: SourcedSkill[] = [];
    const errors: SkillLoadIssue[] = [];
    const seenNames = new Set<string>();
    const seenRealPaths = new Set<string>();

    const accept = (
      found: readonly (DiscoveredSkill & { source: SkillSource })[],
    ) => {
      for (const { skill, realPath, source } of found) {
        if (seenRealPaths.has(realPath)) {
          errors.push(dupRealpathIssue(realPath, skill.path, skill.name));
          continue;
        }

        if (seenNames.has(skill.name)) {
          errors.push(dupNameIssue(skill.name, skill.path));
          continue;
        }

        seenRealPaths.add(realPath);
        seenNames.add(skill.name);
        skills.push({ skill, source });
      }
    };

    // Scan every source concurrently; accept results in precedence order.
    const scannedTiers = yield* Effect.forEach(
      tiers,
      (tier) =>
        Effect.forEach(
          tier.sources,
          Effect.fnUntraced(function* (source) {
            if (source.required === true) {
              const sourceError = yield* validateRequiredSource(source);
              if (sourceError)
                return { source, sourceError, scanned: undefined };
            }
            const scanned = isCommandFile(source)
              ? yield* scanCommandFile(source.path)
              : yield* scanSkillRoot(source.path);
            return { source, sourceError: undefined, scanned };
          }),
          { concurrency: 8 },
        ).pipe(Effect.map((sources) => ({ pooled: tier.pooled, sources }))),
      { concurrency: 'unbounded' },
    );

    for (const tier of scannedTiers) {
      // A name-ordered tier accepts once, after every root is scanned.
      const pooled: (DiscoveredSkill & { source: SkillSource })[] = [];
      for (const { source, sourceError, scanned } of tier.sources) {
        if (scanned === undefined) {
          errors.push(sourceError);
          continue;
        }
        const { plugin } = source;
        const result =
          plugin?.kind !== 'installed'
            ? scanned
            : {
                ...scanned,
                skills: scanned.skills.map((entry) => ({
                  ...entry,
                  skill: {
                    ...entry.skill,
                    name: `${plugin.name}:${entry.skill.name}`,
                  },
                })),
              };
        errors.push(
          ...result.errors.map((error) =>
            source.required === true &&
            error.severity === 'error' &&
            error.code === 'read_error' &&
            error.path === source.path
              ? { ...error, code: 'source_error' as const }
              : error,
          ),
        );

        const found = result.skills.map((entry) => ({ ...entry, source }));
        if (tier.pooled === true) pooled.push(...found);
        else accept(found);
      }
      accept(pooled.toSorted((a, b) => a.entryName.localeCompare(b.entryName)));
    }

    return { skills, errors };
  },
);
