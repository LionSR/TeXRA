import { describe, expect, it } from 'vitest';

import {
  planCompare,
  planLatexdiff,
  planLatexdiffVC,
  planLatexdiffVCPack,
  planMerge,
  planPackClean,
} from '@shared/schemas/mainView';
import { MAIN_VIEW_COMMANDS } from '@shared/ipc/mainViewCommands';

// ============================================================
// planPackClean
// ============================================================

describe('planPackClean', () => {
  const validState = {
    primaryInput: 'main.tex',
    model: 'gpt-5.4',
    inputFiles: ['main.tex'],
    agent: 'correct',
  };

  it('returns the PACK_SINGLE command for a single file pack', () => {
    const plan = planPackClean(validState, 'pack');
    expect(plan.valid).toBe(true);
    if (!plan.valid) return;

    expect(plan.command).toBe(MAIN_VIEW_COMMANDS.PACK_SINGLE);
    expect(plan.payload).toEqual({
      inputFile: 'main.tex',
      agent: 'correct',
      model: 'gpt-5.4',
    });
    expect(plan.payload.inputFiles).toBeUndefined();
    expect(plan.infoText).toBe('Packing single file: main.tex');
  });

  it('returns the CLEAN_SINGLE command for a single file clean', () => {
    const plan = planPackClean(validState, 'clean');
    expect(plan.valid).toBe(true);
    if (!plan.valid) return;

    expect(plan.command).toBe(MAIN_VIEW_COMMANDS.CLEAN_SINGLE);
    expect(plan.payload).toEqual({
      inputFile: 'main.tex',
      agent: 'correct',
      model: 'gpt-5.4',
    });
    expect(plan.payload.inputFiles).toBeUndefined();
    expect(plan.infoText).toBe('Cleaning single file: main.tex');
  });

  it('returns PACK_MULTIPLE for pack with multiple input files', () => {
    const plan = planPackClean(
      {
        ...validState,
        inputFiles: ['main.tex', 'chapter1.tex', 'chapter2.tex'],
      },
      'pack',
    );
    expect(plan.valid).toBe(true);
    if (!plan.valid) return;

    expect(plan.command).toBe(MAIN_VIEW_COMMANDS.PACK_MULTIPLE);
    expect(plan.payload.inputFiles).toEqual(['chapter1.tex', 'chapter2.tex']);
    expect(plan.infoText).toBe(
      'Packing multiple files: main.tex, chapter1.tex, chapter2.tex',
    );
  });

  it('returns CLEAN_MULTIPLE for clean with multiple input files', () => {
    const plan = planPackClean(
      {
        ...validState,
        inputFiles: ['main.tex', 'appendix.tex'],
      },
      'clean',
    );
    expect(plan.valid).toBe(true);
    if (!plan.valid) return;

    expect(plan.command).toBe(MAIN_VIEW_COMMANDS.CLEAN_MULTIPLE);
    expect(plan.payload.inputFiles).toEqual(['appendix.tex']);
    expect(plan.infoText).toBe(
      'Cleaning multiple files: main.tex, appendix.tex',
    );
  });

  it('filters falsy entries from inputFiles', () => {
    const plan = planPackClean(
      {
        ...validState,
        inputFiles: ['main.tex', '', 'chapter1.tex'],
      },
      'pack',
    );
    expect(plan.valid).toBe(true);
    if (!plan.valid) return;

    expect(plan.command).toBe(MAIN_VIEW_COMMANDS.PACK_MULTIPLE);
    expect(plan.payload.inputFiles).toEqual(['chapter1.tex']);
  });

  it('returns invalid when primaryInput is missing', () => {
    const plan = planPackClean({ ...validState, primaryInput: '' }, 'pack');
    expect(plan.valid).toBe(false);
    if (plan.valid) return;
    expect(plan.message).toBe(
      'Please select all required fields (input file and model)',
    );
  });

  it('returns invalid when model is missing', () => {
    const plan = planPackClean({ ...validState, model: '' }, 'pack');
    expect(plan.valid).toBe(false);
    if (plan.valid) return;
    expect(plan.message).toBe(
      'Please select all required fields (input file and model)',
    );
  });
});

// ============================================================
// planMerge
// ============================================================

describe('planMerge', () => {
  it('returns a valid merge plan when both files are selected', () => {
    const plan = planMerge({
      primaryInput: 'main.tex',
      editedFile: 'main-edited.tex',
    });
    expect(plan.valid).toBe(true);
    if (!plan.valid) return;

    expect(plan.command).toBe(MAIN_VIEW_COMMANDS.MERGE);
    expect(plan.payload).toEqual({
      inputFile: 'main.tex',
      editedFile: 'main-edited.tex',
    });
    expect(plan.infoText).toBe('Merging files: main.tex and main-edited.tex');
  });

  it('returns invalid when primaryInput is missing', () => {
    const plan = planMerge({ primaryInput: '', editedFile: 'edited.tex' });
    expect(plan.valid).toBe(false);
    if (plan.valid) return;
    expect(plan.message).toBe(
      'Please select both input and edited files to merge',
    );
  });

  it('returns invalid when editedFile is missing', () => {
    const plan = planMerge({ primaryInput: 'main.tex', editedFile: '' });
    expect(plan.valid).toBe(false);
    if (plan.valid) return;
    expect(plan.message).toBe(
      'Please select both input and edited files to merge',
    );
  });

  it('returns invalid when both files are missing', () => {
    const plan = planMerge({ primaryInput: '', editedFile: '' });
    expect(plan.valid).toBe(false);
    if (plan.valid) return;
    expect(plan.message).toBe(
      'Please select both input and edited files to merge',
    );
  });
});

// ============================================================
// planCompare
// ============================================================

describe('planCompare', () => {
  it('returns a valid compare plan with the given command', () => {
    const plan = planCompare(
      { baseFile: 'old.tex', editedFile: 'new.tex' },
      MAIN_VIEW_COMMANDS.COMPARE,
    );
    expect(plan.valid).toBe(true);
    if (!plan.valid) return;

    expect(plan.command).toBe(MAIN_VIEW_COMMANDS.COMPARE);
    expect(plan.payload).toEqual({
      baseFile: 'old.tex',
      editedFile: 'new.tex',
    });
    expect(plan).not.toHaveProperty('infoText');
  });

  it('uses ACCEPT_EDITED command when provided', () => {
    const plan = planCompare(
      { baseFile: 'old.tex', editedFile: 'new.tex' },
      MAIN_VIEW_COMMANDS.ACCEPT_EDITED,
    );
    expect(plan.valid).toBe(true);
    if (!plan.valid) return;

    expect(plan.command).toBe(MAIN_VIEW_COMMANDS.ACCEPT_EDITED);
    expect(plan.payload).toEqual({
      baseFile: 'old.tex',
      editedFile: 'new.tex',
    });
  });

  it('returns invalid when baseFile is missing', () => {
    const plan = planCompare(
      { baseFile: '', editedFile: 'new.tex' },
      MAIN_VIEW_COMMANDS.COMPARE,
    );
    expect(plan.valid).toBe(false);
    if (plan.valid) return;
    expect(plan.message).toBe(
      'Please select both base and edited files to compare',
    );
  });

  it('returns invalid when editedFile is missing', () => {
    const plan = planCompare(
      { baseFile: 'old.tex', editedFile: '' },
      MAIN_VIEW_COMMANDS.COMPARE,
    );
    expect(plan.valid).toBe(false);
    if (plan.valid) return;
    expect(plan.message).toBe(
      'Please select both base and edited files to compare',
    );
  });
});

// ============================================================
// planLatexdiff
// ============================================================

describe('planLatexdiff', () => {
  it('returns a valid latexdiff plan with the correct payload', () => {
    const plan = planLatexdiff({
      inputFile: 'main.tex',
      baseFile: 'old.tex',
      editedFile: 'new.tex',
    });
    expect(plan.valid).toBe(true);
    if (!plan.valid) return;

    expect(plan.command).toBe(MAIN_VIEW_COMMANDS.LATEXDIFF);
    expect(plan.payload).toEqual({
      inputFile: 'main.tex',
      baseFile: 'old.tex',
      editedFile: 'new.tex',
    });
    expect(plan.infoText).toBe(
      'Running LaTeX diff between old.tex and new.tex',
    );
  });
});

// ============================================================
// planLatexdiffVC
// ============================================================

describe('planLatexdiffVC', () => {
  it('returns a valid latexdiffvc plan with the correct payload', () => {
    const plan = planLatexdiffVC({
      inputFile: 'main.tex',
      baseFile: 'old.tex',
      commitHash: 'abc123',
    });
    expect(plan.valid).toBe(true);
    if (!plan.valid) return;

    expect(plan.command).toBe(MAIN_VIEW_COMMANDS.LATEXDIFFVC);
    expect(plan.payload).toEqual({
      inputFile: 'main.tex',
      baseFile: 'old.tex',
      commitHash: 'abc123',
    });
    expect(plan.infoText).toBe(
      'Running LaTeX diff with version control: old.tex at commit abc123',
    );
  });
});

// ============================================================
// planLatexdiffVCPack
// ============================================================

describe('planLatexdiffVCPack', () => {
  const state = {
    inputFile: 'main.tex',
    baseFile: 'old.tex',
    commitHash: 'def456',
  };

  it('returns PACK_LATEXDIFFVC for the pack action', () => {
    const plan = planLatexdiffVCPack(state, 'pack');
    expect(plan.valid).toBe(true);
    if (!plan.valid) return;

    expect(plan.command).toBe(MAIN_VIEW_COMMANDS.PACK_LATEXDIFFVC);
    expect(plan.payload).toEqual({
      inputFile: 'main.tex',
      baseFile: 'old.tex',
      commitHash: 'def456',
      clean: false,
    });
    expect(plan.infoText).toBe(
      'Packing LaTeX diff with version control: old.tex at commit def456',
    );
  });

  it('returns CLEAN_LATEXDIFFVC for the clean action', () => {
    const plan = planLatexdiffVCPack(state, 'clean');
    expect(plan.valid).toBe(true);
    if (!plan.valid) return;

    expect(plan.command).toBe(MAIN_VIEW_COMMANDS.CLEAN_LATEXDIFFVC);
    expect(plan.payload).toEqual({
      inputFile: 'main.tex',
      baseFile: 'old.tex',
      commitHash: 'def456',
      clean: true,
    });
    expect(plan.infoText).toBe(
      'Cleaning LaTeX diff with version control: old.tex at commit def456',
    );
  });
});
