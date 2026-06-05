import { describe, expect, it } from 'vitest';

import {
  cleanSessionDescription,
  getSessionDescriptionInstruction,
} from '@agent/runtime/sessionDescription';

describe('session description helpers', () => {
  it('normalizes model-generated descriptions for compact UI labels', () => {
    expect(cleanSessionDescription('"Fixing TikZ arrows."')).toBe(
      'Fixing TikZ arrows',
    );
    expect(cleanSessionDescription('Reviewing\n introduction')).toBe(
      'Reviewing introduction',
    );
  });

  it('prefers displayInstruction over hidden prompt context', () => {
    expect(
      getSessionDescriptionInstruction({
        displayInstruction: 'Assess the proof concisely.',
        instruction:
          'Primary user input files:\n- "problem.md"\n\nAdditional user instruction:\n\nAssess the proof concisely.',
      }),
    ).toBe('Assess the proof concisely.');
  });

  it('falls back to instruction when displayInstruction is blank', () => {
    expect(
      getSessionDescriptionInstruction({
        displayInstruction: '   ',
        instruction: 'Summarize the paper.',
      }),
    ).toBe('Summarize the paper.');
  });
});
