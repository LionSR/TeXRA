// Local imports - utilities
import { Data, Result } from 'effect';
import { safeParseYaml } from '@common/parsing/safeParseYaml';
import { splitFrontmatterFence } from '@common/parsing/frontmatterFence';

interface ExtractedFrontmatter {
  frontmatter: unknown;
  body: string;
}

/**
 * Raised when SKILL.md content is not well-formed frontmatter. Distinct from
 * plain read/IO errors so consumers can classify malformed frontmatter by
 * type instead of string-matching error messages.
 */
export class SkillFrontmatterError extends Data.TaggedError(
  'SkillFrontmatterError',
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * Extract strict YAML frontmatter from a SKILL.md file.
 *
 * Both delimiters must be `---` on their own line. The returned body is
 * trimmed because an empty skill body is not useful to the runtime.
 * Throws {@link SkillFrontmatterError} for every malformed-frontmatter case.
 */
export function extractFrontmatter(content: string): ExtractedFrontmatter {
  const split = splitFrontmatterFence(content);
  if (split.kind === 'no-opening-fence') {
    throw new SkillFrontmatterError({
      message: 'SKILL.md must start with YAML frontmatter',
    });
  }
  if (split.kind === 'no-closing-fence') {
    throw new SkillFrontmatterError({
      message: 'SKILL.md frontmatter is missing a closing delimiter',
    });
  }

  const body = split.body.trim();
  if (!body) {
    throw new SkillFrontmatterError({
      message: 'SKILL.md body must be non-empty',
    });
  }

  const parsed = safeParseYaml(split.frontmatterText);
  if (Result.isFailure(parsed)) {
    throw new SkillFrontmatterError({
      message: `Invalid SKILL.md frontmatter: ${parsed.failure.message}`,
      cause: parsed.failure,
    });
  }

  return {
    frontmatter: parsed.success,
    body,
  };
}
