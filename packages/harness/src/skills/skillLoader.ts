// Standard library imports
import * as path from 'node:path';

// Third-party imports
import { Effect, FileSystem, Predicate, Result, Schema } from 'effect';

// Local imports - common
import { splitFrontmatterFence } from '@common/parsing/frontmatterFence';
import { safeParseYaml } from '@common/parsing/safeParseYaml';
import { SkillNameSchema } from '@shared/schemas';
import { toErrorMessage } from '@utils/errors/errorMessage';

// Local imports - skill parsing
import {
  SKILL_DESCRIPTION_MAX_LENGTH,
  SkillSchema,
  type Skill,
} from './SkillSchema';

interface ExtractedFrontmatter {
  frontmatter: unknown;
  body: string;
}

/**
 * Raised when SKILL.md content is not well-formed frontmatter. Distinct from
 * plain read/IO errors so consumers can classify malformed frontmatter by
 * type instead of string-matching error messages.
 */
class SkillFrontmatterError extends Schema.TaggedError<SkillFrontmatterError>()(
  'SkillFrontmatterError',
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

/**
 * Extract strict YAML frontmatter from a SKILL.md file.
 *
 * Both delimiters must be `---` on their own line. The returned body is
 * trimmed because an empty skill body is not useful to the runtime.
 * Fails with {@link SkillFrontmatterError} for every malformed-frontmatter
 * case.
 */
function extractFrontmatter(
  content: string,
): Result.Result<ExtractedFrontmatter, SkillFrontmatterError> {
  const split = splitFrontmatterFence(content);
  if (split.kind === 'no-opening-fence') {
    return Result.fail(
      new SkillFrontmatterError({
        message: 'SKILL.md must start with YAML frontmatter',
      }),
    );
  }
  if (split.kind === 'no-closing-fence') {
    return Result.fail(
      new SkillFrontmatterError({
        message: 'SKILL.md frontmatter is missing a closing delimiter',
      }),
    );
  }

  const body = split.body.trim();
  if (!body) {
    return Result.fail(
      new SkillFrontmatterError({
        message: 'SKILL.md body must be non-empty',
      }),
    );
  }

  const parsed = safeParseYaml(split.frontmatterText);
  if (Result.isFailure(parsed)) {
    return Result.fail(
      new SkillFrontmatterError({
        message: `Invalid SKILL.md frontmatter: ${parsed.failure.message}`,
        cause: parsed.failure,
      }),
    );
  }

  return Result.succeed({ frontmatter: parsed.success, body });
}

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

function normalizeSkillName(
  rawName: unknown,
  directoryName: string,
  skillPath: string,
): { name?: string; errors: SkillLoadIssue[] } {
  const errors: SkillLoadIssue[] = [];
  const candidate = typeof rawName === 'string' ? rawName : directoryName;
  const parsed = Schema.decodeUnknownResult(SkillNameSchema)(candidate);

  if (Result.isSuccess(parsed)) {
    const name = parsed.success;
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
        `Ignoring invalid skill name: ${parsed.failure.message}`,
        { path: skillPath },
      ),
    );
  }

  const fallback = Schema.decodeUnknownResult(SkillNameSchema)(directoryName);
  if (Result.isSuccess(fallback)) {
    return { name: fallback.success, errors };
  }

  errors.push(
    issue(
      'error',
      'invalid_name',
      `Directory name cannot be used as a skill name: ${fallback.failure.message}`,
      { path: skillPath },
    ),
  );
  return { errors };
}

function normalizeSkillDescription(
  rawDescription: unknown,
  skillPath: string,
  name: string,
): { description?: string; errors: SkillLoadIssue[] } {
  const errors: SkillLoadIssue[] = [];
  const description =
    typeof rawDescription === 'string'
      ? rawDescription.replaceAll(/\s+/g, ' ').trim()
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
      const nameResult = normalizeSkillName(undefined, directoryName, file);
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
        frontmatter.description ?? firstLine,
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
        skill: Schema.decodeUnknownSync(SkillSchema)({
          name: nameResult.name,
          description: descriptionResult.description,
          body,
          baseDir: path.dirname(file),
          path: file,
        }),
        errors,
      };
    }),
    Effect.orElseSucceed((err): LoadedSkill => ({
      errors: [
        issue('error', 'read_error', toErrorMessage(err), { path: file }),
      ],
    })),
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
    Effect.flatMap((content) => Effect.fromResult(extractFrontmatter(content))),
    Effect.flatMap(({ frontmatter, body }) => {
      if (!Predicate.isObject(frontmatter)) {
        return Effect.succeed<LoadedSkill>({
          errors: [
            issue(
              'error',
              'invalid_frontmatter',
              'SKILL.md frontmatter must be a YAML object',
              { path: skillPath },
            ),
          ],
        });
      }

      const nameResult = normalizeSkillName(
        frontmatter.name,
        directoryName,
        skillPath,
      );
      const errors = [...nameResult.errors];
      if (!nameResult.name) return Effect.succeed<LoadedSkill>({ errors });

      const descriptionResult = normalizeSkillDescription(
        frontmatter.description,
        skillPath,
        nameResult.name,
      );
      errors.push(...descriptionResult.errors);
      if (!descriptionResult.description) {
        return Effect.succeed<LoadedSkill>({ errors });
      }

      return Schema.decodeUnknownEffect(SkillSchema)({
        name: nameResult.name,
        description: descriptionResult.description,
        body,
        baseDir: skillDir,
        path: skillPath,
      }).pipe(Effect.map((skill): LoadedSkill => ({ skill, errors })));
    }),
    // Malformed frontmatter is its own issue; anything else (a failed read
    // included) is a read error.
    Effect.catchTag('SkillFrontmatterError', (err) =>
      Effect.succeed<LoadedSkill>({
        errors: [
          issue('error', 'invalid_frontmatter', err.message, {
            path: skillPath,
          }),
        ],
      }),
    ),
    Effect.catch((err) =>
      Effect.succeed<LoadedSkill>({
        errors: [
          issue('error', 'read_error', toErrorMessage(err), {
            path: skillPath,
          }),
        ],
      }),
    ),
  );
}
