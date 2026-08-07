import { describe, expect, it } from 'vitest';

import {
  planCurrentFileAsBase,
  planCurrentFileAsEdited,
} from '@controllers/mainView/MainViewBaseFileController';

type FilePlan = ReturnType<typeof planCurrentFileAsBase>;

function expectNotification(plan: FilePlan, messagePart: string): void {
  expect(plan.notification?.message).toContain(messagePart);
}

describe('MainViewBaseFileController', () => {
  describe('planCurrentFileAsBase', () => {
    it('selects the derived base file when it exists on disk', () => {
      const plan = planCurrentFileAsBase(
        '/workspace/paper-diff1234abcd.tex',
        '/workspace/paper.tex',
        true,
      );

      expect(plan).toEqual({
        filePathToSelect: '/workspace/paper.tex',
        shouldPostSetCurrentFile: true,
        shouldRequestBaseFile: true,
      });
    });

    it('keeps the current file and notifies when the derived base file is missing', () => {
      const plan = planCurrentFileAsBase(
        '/workspace/paper-diff1234abcd.tex',
        '/workspace/paper.tex',
        false,
      );

      expect(plan).toMatchObject({
        filePathToSelect: '/workspace/paper-diff1234abcd.tex',
        shouldPostSetCurrentFile: true,
        shouldRequestBaseFile: false,
      });
      expectNotification(plan, 'could not be found');
      expect(plan.log).toBeDefined();
      expect(plan.log!.level).toBe('info');
      expect(plan.log!.message).toContain('does not exist on disk');
    });

    it('selects the current file as-is when it is not a latexdiff file (no-workspace / no derivation)', () => {
      const plan = planCurrentFileAsBase('/workspace/paper.tex', null, false);

      expect(plan).toEqual({
        filePathToSelect: '/workspace/paper.tex',
        shouldPostSetCurrentFile: true,
        shouldRequestBaseFile: false,
      });
    });
  });

  describe('planCurrentFileAsEdited', () => {
    it('validates a matching edited file name', () => {
      const plan = planCurrentFileAsEdited(
        '/workspace/paper-comments.tex',
        '/workspace/paper.tex',
      );

      expect(plan).toEqual({
        filePathToSelect: '/workspace/paper-comments.tex',
        shouldPostSetCurrentFile: true,
        shouldRequestBaseFile: false,
      });
    });

    it('rejects when no base file is selected', () => {
      const plan = planCurrentFileAsEdited(
        '/workspace/paper-comments.tex',
        undefined,
      );

      expect(plan).toMatchObject({
        filePathToSelect: '/workspace/paper-comments.tex',
        shouldPostSetCurrentFile: false,
        shouldRequestBaseFile: false,
      });
      expectNotification(plan, 'Choose a base file');
    });

    it('rejects when the current file does not match the base file naming pattern', () => {
      const plan = planCurrentFileAsEdited(
        '/workspace/other.tex',
        '/workspace/paper.tex',
      );

      expect(plan).toMatchObject({
        filePathToSelect: '/workspace/other.tex',
        shouldPostSetCurrentFile: false,
        shouldRequestBaseFile: false,
      });
      expectNotification(plan, 'not a valid edited version');
    });

    it('rejects when the current file has the same name as the base file', () => {
      const plan = planCurrentFileAsEdited(
        '/workspace/paper.tex',
        '/workspace/paper.tex',
      );

      expect(plan).toMatchObject({
        shouldPostSetCurrentFile: false,
      });
      expectNotification(plan, 'not a valid edited version');
    });
  });
});
