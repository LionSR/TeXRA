// Third-party imports
import * as yaml from 'yaml';

// Local imports - utilities
import { normalizeLineEndings } from '@utils/text/stringUtils';

export interface ExtractedFrontmatter {
  frontmatter: unknown;
  body: string;
}

/**
 * Extract strict YAML frontmatter from a SKILL.md file.
 *
 * Both delimiters must be `---` on their own line. The returned body is
 * trimmed because an empty skill body is not useful to the runtime.
 */
export function extractFrontmatter(content: string): ExtractedFrontmatter {
  const lines = normalizeLineEndings(content).split('\n');
  if (lines[0] !== '---') {
    throw new Error('SKILL.md must start with YAML frontmatter');
  }

  const closeIndex = lines.indexOf('---', 1);
  if (closeIndex < 0) {
    throw new Error('SKILL.md frontmatter is missing a closing delimiter');
  }

  const frontmatterText = lines.slice(1, closeIndex).join('\n');
  const body = lines
    .slice(closeIndex + 1)
    .join('\n')
    .trim();
  if (!body) {
    throw new Error('SKILL.md body must be non-empty');
  }

  try {
    return {
      frontmatter: yaml.parse(frontmatterText),
      body,
    };
  } catch (err) {
    throw new Error(`Invalid SKILL.md frontmatter: ${String(err)}`);
  }
}
