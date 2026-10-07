// Standard library imports
import * as path from 'node:path';

// Third-party imports
import { Effect, FileSystem, Predicate, Result } from 'effect';
import { ZodError } from 'zod';

// Local imports - common
import { splitFrontmatterFence } from '@common/parsing/frontmatterFence';
import { safeParseYaml } from '@common/parsing/safeParseYaml';
import { SkillNameSchema } from '@shared/schemas';
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
 * malformed-frontmatter case; anything else (a failed read included) is a
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
 * Read one plugin command (`commands/<name>.md`, a Claude Code slash command)
 * as the skill its file name names: its frontmatter, when it has one, may
 * give a description, and otherwise its first line of text does. Never
 * fails, like {@link loadSkillDirectory}.
 */
export function loadCommandFile(
  file: string,
): Effect.Effect<LoadedSkill, never, FileSystem.FileSystem> {
  const directoryName = path.basename(file, '.md');
  return FileSystem.FileSystem.use((fs) => fs.readFileString(file)).pipe(
    Effect.map((content): LoadedSkill => {
      const split = splitFrontmatterFence(content);
      const parsed =
        split.kind === 'ok' ? safeParseYaml(split.frontmatterText) : undefined;
      const frontmatter =
        parsed !== undefined &&
        Result.isSuccess(parsed) &&
        Predicate.isObject(parsed.success)
          ? parsed.success
          : {};
      const body = (split.kind === 'ok' ? split.body : content).trim();
      const nameResult = normalizeSkillName({}, directoryName, file);
      if (!nameResult.name) return { errors: nameResult.errors };
      if (!body)
        return {
          errors: [
            issue('error', 'missing_description', 'Command file is empty', {
              path: file,
              name: nameResult.name,
            }),
          ],
        };
      const firstLine = body
        .split('\n')
        .map((line) => line.replace(/^#+\s*/, '').trim())
        .find(Boolean);
      const descriptionResult = normalizeSkillDescription(
        { description: frontmatter.description ?? firstLine },
        file,
        nameResult.name,
      );
      const errors = [...nameResult.errors, ...descriptionResult.errors];
      if (parsed !== undefined && Result.isFailure(parsed))
        errors.push(
          issue(
            'warning',
            'invalid_frontmatter',
            `Ignoring the command's frontmatter: ${parsed.failure.message}`,
            { path: file, name: nameResult.name },
          ),
        );
      if (!descriptionResult.description) return { errors };
      return {
        skill: SkillSchema.parse({
          name: nameResult.name,
          description: descriptionResult.description,
          body,
          baseDir: path.dirname(file),
          path: file,
        }),
        errors,
      };
    }),
    Effect.catch((err) =>
      Effect.succeed<LoadedSkill>({
        errors: [
          issue('error', 'read_error', toErrorMessage(err), { path: file }),
        ],
      }),
    ),
  );
}

/**
 * Read and parse one skill package. Never fails: a missing or malformed
 * `SKILL.md` answers with the issue list the caller reports, so one bad
 * directory cannot abort a scan.
 */
export function loadSkillDirectory(
  skillDir: string,
  directoryName: string,
): Effect.Effect<LoadedSkill, never, FileSystem.FileSystem> {
  const skillPath = path.join(skillDir, 'SKILL.md');

  return FileSystem.FileSystem.use((fs) => fs.readFileString(skillPath)).pipe(
    Effect.flatMap((content) =>
      Effect.try({
        try: (): LoadedSkill => {
          const { frontmatter, body } = extractFrontmatter(content);
          if (!Predicate.isObject(frontmatter)) {
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
