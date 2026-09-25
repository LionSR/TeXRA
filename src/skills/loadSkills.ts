// Standard library imports
import * as path from 'node:path';

// Third-party imports
import { Effect, FileSystem } from 'effect';

// Local imports - common
import { isNotADirectoryError } from '@common/errors';
import type { ActiveSkillSourceScope } from '@shared/schemas';
import { byString } from '@utils/core';
import { absentReason } from '@utils/files/fsEntryExists';

// Local imports - skill parsing
import { type SkillLoadIssue, issue, loadSkillDirectory } from './skillLoader';
import type { Skill } from './SkillSchema';

export { type SkillLoadIssue } from './skillLoader';

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
 *  (`@shared/schemas/activeSkills`) so the loader and the persisted snapshot
 *  can't drift. */
export interface SkillSource {
  readonly scope: ActiveSkillSourceScope;
  readonly path: string;
  readonly label?: string;
  readonly required?: boolean;
}

/**
 * One precedence tier of sources. A `source` tier scans its roots one after
 * another; a `name` tier pools its roots and orders their skills by directory
 * name, the order one root holding all of them would give.
 */
export interface SkillSourceTier {
  readonly order: 'source' | 'name';
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
  return issue(
    'warning',
    'duplicate_name',
    `Skipping duplicate skill name "${name}"`,
    { path, name },
  );
}

function dupRealpathIssue(
  realPath: string,
  path: string,
  name?: string,
): SkillLoadIssue {
  return issue(
    'warning',
    'duplicate_realpath',
    `Skipping duplicate skill path ${realPath}`,
    name === undefined ? { path } : { path, name },
  );
}

/**
 * Discover one-level `SKILL.md` packages below `root`.
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
  const seenNames = new Set<string>();
  const seenRealPaths = new Set<string>();

  const names: string[] | undefined = yield* fs.readDirectory(root).pipe(
    Effect.catch((error) =>
      Effect.sync(() => {
        if (error.reason._tag !== 'NotFound') {
          errors.push(
            issue('error', 'read_error', error.message, { path: root }),
          );
        }
        return undefined;
      }),
    ),
  );
  if (names === undefined) return { skills, errors };

  for (const name of names.toSorted(byString)) {
    const skillDir = path.join(root, name);
    const skillPath = path.join(skillDir, 'SKILL.md');
    const realSkillPath: string | undefined = yield* fs
      .realPath(skillPath)
      .pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            if (!absentReason(error)) {
              errors.push(
                issue('warning', 'read_error', error.message, {
                  path: skillPath,
                }),
              );
            }
            return undefined;
          }),
        ),
      );
    if (realSkillPath === undefined) continue;

    if (seenRealPaths.has(realSkillPath)) {
      errors.push(dupRealpathIssue(realSkillPath, skillPath));
      continue;
    }
    seenRealPaths.add(realSkillPath);

    const loaded = yield* loadSkillDirectory(skillDir, name);
    errors.push(...loaded.errors);
    if (!loaded.skill) continue;

    if (seenNames.has(loaded.skill.name)) {
      errors.push(dupNameIssue(loaded.skill.name, loaded.skill.path));
      continue;
    }

    seenNames.add(loaded.skill.name);
    skills.push({
      skill: loaded.skill,
      realPath: realSkillPath,
      entryName: name,
    });
  }

  return { skills, errors };
});

/**
 * Validate a `required` skill source, returning an issue when the path is
 * missing or not a directory. Optional sources skip this check entirely.
 */
function validateRequiredSource(
  source: SkillSource,
): Effect.Effect<SkillLoadIssue | undefined, never, FileSystem.FileSystem> {
  const notADirectory = () =>
    issue('error', 'invalid_source', 'Skill source is not a directory', {
      path: source.path,
    });
  return FileSystem.FileSystem.use((fs) => fs.stat(source.path)).pipe(
    Effect.map((info) =>
      info.type === 'Directory' ? undefined : notADirectory(),
    ),
    Effect.catch((error) => {
      if (error.reason._tag === 'NotFound') {
        return Effect.succeed(
          issue('error', 'missing_source', 'Skill source does not exist', {
            path: source.path,
          }),
        );
      }
      if (
        error.reason._tag === 'BadResource' &&
        isNotADirectoryError(error.reason.cause)
      ) {
        return Effect.succeed(notADirectory());
      }
      return Effect.succeed(
        issue('error', 'source_read_error', error.message, {
          path: source.path,
        }),
      );
    }),
  );
}

/**
 * Discover skills from tiers of roots in precedence order.
 *
 * On top of the per-root scan this adds the cross-root invariants runtimes
 * need: a skill name or canonical `SKILL.md` file is accepted only from the
 * first source that provides it, in the tier's order.
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

    for (const tier of tiers) {
      // A name-ordered tier accepts once, after every root is scanned.
      const pooled: (DiscoveredSkill & { source: SkillSource })[] = [];
      for (const source of tier.sources) {
        if (source.required === true) {
          const sourceError = yield* validateRequiredSource(source);
          if (sourceError) {
            errors.push(sourceError);
            continue;
          }
        }

        const result = yield* scanSkillRoot(source.path);
        errors.push(
          ...result.errors.map((error) =>
            source.required === true &&
            error.severity === 'error' &&
            error.code === 'read_error' &&
            error.path === source.path
              ? { ...error, code: 'source_read_error' as const }
              : error,
          ),
        );

        const found = result.skills.map((entry) => ({ ...entry, source }));
        if (tier.order === 'source') accept(found);
        else pooled.push(...found);
      }
      accept(pooled.toSorted((a, b) => a.entryName.localeCompare(b.entryName)));
    }

    return { skills, errors };
  },
);
