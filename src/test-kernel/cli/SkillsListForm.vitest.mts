import { describe, expect, it } from 'vitest';

import {
  skillSelectItemsForTui,
  skillsSelectWindow,
} from '@cli/chat/tui/forms/SkillsListForm';
import type { SourcedSkill } from '@skills/loadSkills';

function sourcedSkill(options: {
  readonly name: string;
  readonly description: string;
  readonly scope: SourcedSkill['source']['scope'];
  readonly label?: string;
}): SourcedSkill {
  const baseDir = `/tmp/${options.name}`;
  const skillPath = `${baseDir}/SKILL.md`;
  return {
    skill: {
      name: options.name,
      description: options.description,
      body: `Use ${options.name}.`,
      baseDir,
      path: skillPath,
      frontmatter: {
        name: options.name,
        description: options.description,
      },
    },
    source: {
      scope: options.scope,
      path: '/tmp/.texra/skills',
      label: options.label,
    },
  };
}

describe('SkillsListForm helpers', () => {
  it('formats skill select rows with source labels and descriptions', () => {
    expect(
      skillSelectItemsForTui([
        sourcedSkill({
          name: 'proof-audit',
          description: 'Review mathematical proof steps.',
          scope: 'project',
          label: 'project',
        }),
      ]),
    ).toEqual([
      {
        value: '/tmp/proof-audit/SKILL.md',
        label: 'proof-audit',
        description: 'project · Review mathematical proof steps.',
      },
    ]);
  });

  it('reserves one extra row when import issues are visible', () => {
    expect(
      skillsSelectWindow({
        availableRows: 10,
        itemCount: 10,
        hasIssues: false,
      }),
    ).toEqual({ maxVisibleItems: 3, showOverflow: true });
    expect(
      skillsSelectWindow({
        availableRows: 10,
        itemCount: 10,
        hasIssues: true,
      }),
    ).toEqual({ maxVisibleItems: 2, showOverflow: true });
  });
});
