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
  it('formats skill select rows with source labels and descriptions', () => {
    const skill = sourcedSkill({
      name: 'proof-audit',
      description: 'Review mathematical proof steps.',
      scope: 'project',
      label: 'project',
    });

    expect(skillSelectItemsForTui([skill])).toEqual([
      {
        value: {
          name: 'proof-audit',
          activationPrompt: formatSkillActivationPrompt(skill),
        },
        label: 'proof-audit',
        description: 'project · Review mathematical proof steps.',
      },
    ]);
  });

  it('formats the skill activation prompt with the skill body', () => {
    const prompt = formatSkillActivationPrompt(
      sourcedSkill({
        name: 'proof-audit',
        description: 'Review mathematical proof steps.',
        scope: 'project',
      }),
    );

    expect(prompt).toContain('<skill_activation>');
    expect(prompt).toContain('<skill name="proof-audit">');
    expect(prompt).toContain('<path>/tmp/proof-audit/SKILL.md</path>');
    expect(prompt).toContain('Use proof-audit.');
  });

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
