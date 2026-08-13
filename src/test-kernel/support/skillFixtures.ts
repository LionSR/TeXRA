// Node imports
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/**
 * Writes a SKILL.md package under `root` and returns the SKILL.md path; its
 * `path.dirname` is the skill directory. Omitting `description` produces the
 * frontmatter a skill with no description has.
 */
export async function writeSkill(
  root: string,
  dirName: string,
  frontmatter: { readonly name: string; readonly description?: string },
  body = 'Use this skill carefully.',
): Promise<string> {
  const skillDir = path.join(root, dirName);
  await fs.mkdir(skillDir, { recursive: true });
  const lines = [`name: ${frontmatter.name}`];
  if (frontmatter.description !== undefined) {
    lines.push(`description: ${frontmatter.description}`);
  }
  const skillPath = path.join(skillDir, 'SKILL.md');
  await fs.writeFile(skillPath, `---\n${lines.join('\n')}\n---\n\n${body}\n`);
  return skillPath;
}
