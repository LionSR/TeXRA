// Local imports - utilities
import { safeParseYaml } from '@common/parsing/safeParseYaml';
import { normalizeLineEndings } from '@utils/text/stringUtils';

export interface ExtractedFrontmatter {
  frontmatter: unknown;
  body: string;
}

/**
 * Raised when SKILL.md content is not well-formed frontmatter. Distinct from
 * plain read/IO errors so consumers can classify malformed frontmatter by
 * type instead of string-matching error messages.
 */
export class SkillFrontmatterError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SkillFrontmatterError';
  }
}

/**
 * Extract strict YAML frontmatter from a SKILL.md file.
 *
 * Both delimiters must be `---` on their own line. The returned body is
 * trimmed because an empty skill body is not useful to the runtime.
 * Throws {@link SkillFrontmatterError} for every malformed-frontmatter case.
 */
export function extractFrontmatter(content: string): ExtractedFrontmatter {
  const lines = normalizeLineEndings(content).split('\n');
  if (lines[0] !== '---') {
    throw new SkillFrontmatterError(
      'SKILL.md must start with YAML frontmatter',
    );
  }

  const closeIndex = lines.indexOf('---', 1);
  if (closeIndex < 0) {
    throw new SkillFrontmatterError(
      'SKILL.md frontmatter is missing a closing delimiter',
    );
  }

  const frontmatterText = lines.slice(1, closeIndex).join('\n');
  const body = lines
    .slice(closeIndex + 1)
    .join('\n')
    .trim();
  if (!body) {
    throw new SkillFrontmatterError('SKILL.md body must be non-empty');
  }

  const parsed = safeParseYaml(frontmatterText);
  if (parsed.isErr()) {
    throw new SkillFrontmatterError(
      `Invalid SKILL.md frontmatter: ${parsed.error.message}`,
      { cause: parsed.error },
    );
  }

  return {
    frontmatter: parsed.value,
    body,
  };
}
