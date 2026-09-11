import { describe, expect, it } from 'vitest';

import {
  formatSkillActivationPrompt,
  skillSelectItemsForTui,
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
    },
    source: {
      scope: options.scope,
      path: '/tmp/.texra/skills',
      label: options.label,
    },
  };
}

describe('SkillsListForm helpers', () => {
  it('escapes skill names in activation prose defensively', () => {
    const prompt = formatSkillActivationPrompt(
      sourcedSkill({
        name: 'proof<audit &',
        description: 'Review mathematical proof steps.',
        scope: 'project',
      }),
    );

    expect(prompt).toContain(
      'The user selected the proof&lt;audit &amp; skill.',
    );
  });
});
