// Standard library imports
import type { Dirent } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

// Third-party imports
import { ZodError } from 'zod';

// Local imports - common
import { isFileNotFoundError, toErrorMessage } from '@common/errors';

// Local imports - skill parsing
import {
  SKILL_DESCRIPTION_MAX_LENGTH,
  SkillNameSchema,
  SkillSchema,
  type Skill,
} from './SkillSchema';
import { extractFrontmatter } from './frontmatter';

// Local imports - utilities
import { collapseWhitespace } from '@utils/text/stringUtils';

export type SkillIssueSeverity = 'error' | 'warning';

export type SkillIssueCode =
  | 'duplicate_name'
  | 'duplicate_realpath'
  | 'invalid_frontmatter'
  | 'invalid_name'
  | 'missing_description'
  | 'name_mismatch'
  | 'read_error';

export interface SkillLoadIssue {
  severity: SkillIssueSeverity;
  code: SkillIssueCode;
  message: string;
  path?: string;
  name?: string;
}

export interface DiscoverSkillsResult {
  skills: Skill[];
  errors: SkillLoadIssue[];
}

interface LoadedSkill {
  skill?: Skill;
  errors: SkillLoadIssue[];
}

function issue(
  severity: SkillIssueSeverity,
  code: SkillIssueCode,
  message: string,
  options: { path?: string; name?: string } = {},
): SkillLoadIssue {
  return { severity, code, message, ...options };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function firstZodMessage(error: ZodError): string {
  return error.issues[0]?.message ?? 'Invalid skill metadata';
}

/**
 * `extractFrontmatter` throws plain errors whose messages begin with `SKILL.md`
 * or `Invalid SKILL.md`. Treat those as malformed frontmatter; anything else
 * (e.g. a failed `readFile`) is a read error.
 */
function skillReadErrorCode(err: unknown): SkillIssueCode {
  if (
    err instanceof Error &&
    (err.message.startsWith('SKILL.md') ||
      err.message.startsWith('Invalid SKILL.md'))
  ) {
    return 'invalid_frontmatter';
  }
  return 'read_error';
}

function normalizeSkillName(
  frontmatter: Record<string, unknown>,
  directoryName: string,
  skillPath: string,
): { name?: string; errors: SkillLoadIssue[] } {
  const errors: SkillLoadIssue[] = [];
  const rawName = frontmatter.name;
  const candidate = typeof rawName === 'string' ? rawName : directoryName;
  const parsed = SkillNameSchema.safeParse(candidate);

  if (parsed.success) {
    const name = parsed.data;
    if (typeof rawName === 'string' && name !== directoryName) {
      errors.push(
        issue(
          'warning',
          'name_mismatch',
          `Skill name "${name}" does not match directory "${directoryName}"`,
          { path: skillPath, name },
        ),
      );
    }
    return { name, errors };
  }

  if (rawName !== undefined) {
    errors.push(
      issue(
        'warning',
        'invalid_name',
        `Ignoring invalid skill name: ${firstZodMessage(parsed.error)}`,
        { path: skillPath },
      ),
    );
  }

  const fallback = SkillNameSchema.safeParse(directoryName);
  if (fallback.success) {
    return { name: fallback.data, errors };
  }

  errors.push(
    issue(
      'error',
      'invalid_name',
      `Directory name cannot be used as a skill name: ${firstZodMessage(
        fallback.error,
      )}`,
      { path: skillPath },
    ),
  );
  return { errors };
}

function normalizeSkillDescription(
  frontmatter: Record<string, unknown>,
  skillPath: string,
  name: string,
): { description?: string; errors: SkillLoadIssue[] } {
  const errors: SkillLoadIssue[] = [];
  const rawDescription = frontmatter.description;
  const description =
    typeof rawDescription === 'string'
      ? collapseWhitespace(rawDescription)
      : '';

  if (!description) {
    errors.push(
      issue('error', 'missing_description', 'Skill description is required', {
        path: skillPath,
        name,
      }),
    );
    return { errors };
  }

  if (description.length > SKILL_DESCRIPTION_MAX_LENGTH) {
    errors.push(
      issue(
        'warning',
        'invalid_frontmatter',
        `Skill description exceeds ${SKILL_DESCRIPTION_MAX_LENGTH} characters and was truncated`,
        { path: skillPath, name },
      ),
    );
    return {
      description: description.slice(0, SKILL_DESCRIPTION_MAX_LENGTH),
      errors,
    };
  }

  return { description, errors };
}

async function loadSkillDirectory(
  skillDir: string,
  directoryName: string,
): Promise<LoadedSkill> {
  const skillPath = path.join(skillDir, 'SKILL.md');

  try {
    const content = await fs.readFile(skillPath, 'utf8');
    const { frontmatter, body } = extractFrontmatter(content);
    if (!isRecord(frontmatter)) {
      return {
        errors: [
          issue(
            'error',
            'invalid_frontmatter',
            'SKILL.md frontmatter must be a YAML object',
            { path: skillPath },
          ),
        ],
      };
    }

    const nameResult = normalizeSkillName(
      frontmatter,
      directoryName,
      skillPath,
    );
    const errors = [...nameResult.errors];
    if (!nameResult.name) return { errors };

    const descriptionResult = normalizeSkillDescription(
      frontmatter,
      skillPath,
      nameResult.name,
    );
    errors.push(...descriptionResult.errors);
    if (!descriptionResult.description) return { errors };

    const normalizedFrontmatter = {
      ...frontmatter,
      name: nameResult.name,
      description: descriptionResult.description,
    };
    const skill = SkillSchema.parse({
      name: nameResult.name,
      description: descriptionResult.description,
      body,
      baseDir: skillDir,
      path: skillPath,
      frontmatter: normalizedFrontmatter,
    });

    return { skill, errors };
  } catch (err) {
    return {
      errors: [
        issue('error', skillReadErrorCode(err), toErrorMessage(err), {
          path: skillPath,
        }),
      ],
    };
  }
}

/**
 * Discover one-level `SKILL.md` packages below `root`.
 *
 * Missing roots are treated as empty because user and project skill directories
 * are optional. Per-skill failures are reported and do not abort discovery.
 */
export async function discoverSkills(
  root: string,
): Promise<DiscoverSkillsResult> {
  const skills: Skill[] = [];
  const errors: SkillLoadIssue[] = [];
  const seenNames = new Set<string>();
  const seenRealPaths = new Set<string>();

  let entries: Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (err) {
    if (isFileNotFoundError(err)) {
      return { skills, errors };
    }

    errors.push(
      issue('error', 'read_error', toErrorMessage(err), {
        path: root,
      }),
    );
    return { skills, errors };
  }

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;

    const skillDir = path.join(root, entry.name);
    const skillPath = path.join(skillDir, 'SKILL.md');
    let realSkillPath: string;
    try {
      realSkillPath = await fs.realpath(skillPath);
    } catch (err) {
      if (!isFileNotFoundError(err)) {
        errors.push(
          issue('warning', 'read_error', toErrorMessage(err), {
            path: skillPath,
          }),
        );
      }
      continue;
    }

    if (seenRealPaths.has(realSkillPath)) {
      errors.push(
        issue(
          'warning',
          'duplicate_realpath',
          `Skipping duplicate skill path ${realSkillPath}`,
          { path: skillPath },
        ),
      );
      continue;
    }
    seenRealPaths.add(realSkillPath);

    const loaded = await loadSkillDirectory(skillDir, entry.name);
    errors.push(...loaded.errors);
    if (!loaded.skill) continue;

    if (seenNames.has(loaded.skill.name)) {
      errors.push(
        issue(
          'warning',
          'duplicate_name',
          `Skipping duplicate skill name "${loaded.skill.name}"`,
          { path: loaded.skill.path, name: loaded.skill.name },
        ),
      );
      continue;
    }

    seenNames.add(loaded.skill.name);
    skills.push(loaded.skill);
  }

  return { skills, errors };
}
