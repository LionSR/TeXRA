// Standard library imports
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

// Third-party imports
import { Effect } from 'effect';
import { ZodError } from 'zod';

// Local imports - common
import { SkillNameSchema } from '@shared/schemas';
import { isObject } from '@utils/core';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';

// Local imports - skill parsing
import { collapseWhitespace } from '@utils/text/stringUtils';
import {
  SKILL_DESCRIPTION_MAX_LENGTH,
  SkillSchema,
  type Skill,
} from './SkillSchema';
import { extractFrontmatter, SkillFrontmatterError } from './frontmatter';

export type SkillIssueSeverity = 'error' | 'warning';

export type SkillIssueCode =
  | 'duplicate_name'
  | 'duplicate_realpath'
  | 'invalid_frontmatter'
  | 'invalid_name'
  | 'invalid_source'
  | 'missing_source'
  | 'missing_description'
  | 'name_mismatch'
  | 'read_error'
  | 'source_read_error';

export interface SkillLoadIssue {
  severity: SkillIssueSeverity;
  code: SkillIssueCode;
  message: string;
  path?: string;
  name?: string;
}

export interface LoadedSkill {
  skill?: Skill;
  errors: SkillLoadIssue[];
}

export function issue(
  severity: SkillIssueSeverity,
  code: SkillIssueCode,
  message: string,
  options: { path?: string; name?: string } = {},
): SkillLoadIssue {
  return { severity, code, message, ...options };
}

function firstZodMessage(error: ZodError): string {
  return error.issues[0]?.message ?? 'Invalid skill metadata';
}

/**
 * `extractFrontmatter` throws a typed {@link SkillFrontmatterError} for every
 * malformed-frontmatter case; anything else (e.g. a failed `readFile`) is a
 * read error.
 */
function skillReadErrorCode(err: unknown): SkillIssueCode {
  if (err instanceof SkillFrontmatterError) return 'invalid_frontmatter';
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

/**
 * Read and parse one skill package. Never fails: a missing or malformed
 * `SKILL.md` answers with the issue list the caller reports, so one bad
 * directory cannot abort a scan.
 */
export function loadSkillDirectory(
  skillDir: string,
  directoryName: string,
): Effect.Effect<LoadedSkill> {
  const skillPath = path.join(skillDir, 'SKILL.md');

  return Effect.tryPromise({
    try: () => fs.readFile(skillPath, 'utf8'),
    // The raw failure decides the issue code, so it is carried through
    // unwrapped rather than classified twice.
    catch: ensureError,
  }).pipe(
    Effect.flatMap((content) =>
      Effect.try({
        try: (): LoadedSkill => {
          const { frontmatter, body } = extractFrontmatter(content);
          if (!isObject(frontmatter)) {
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

          const skill = SkillSchema.parse({
            name: nameResult.name,
            description: descriptionResult.description,
            body,
            baseDir: skillDir,
            path: skillPath,
          });

          return { skill, errors };
        },
        catch: ensureError,
      }),
    ),
    Effect.catch((err) =>
      Effect.succeed<LoadedSkill>({
        errors: [
          issue('error', skillReadErrorCode(err), toErrorMessage(err), {
            path: skillPath,
          }),
        ],
      }),
    ),
  );
}
