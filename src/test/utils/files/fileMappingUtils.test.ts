// Node.js built-in imports
import { strict as assert } from 'assert';

// Internal imports
import { replaceInputCommands } from '@utils/files/fileMappingUtils';
import { flexibleFS } from '@utils/files/flexibleFS';

describe('replaceInputCommands', () => {
  it('rewrites nested and extensionless input commands', async () => {
    const baseFiles = ['main.tex', 'chapters/intro.tex', 'appendix.tex'];
    const outputFiles = ['main.tex', 'chapters/intro.tex', 'appendix.tex'];

    const originalMain = [
      '\\documentclass{article}',
      '\\input{chapters/intro}',
      '\\input{appendix}',
      '\\input{chapters/intro.tex}',
    ].join('\n');

    const files = new Map<string, string>([
      ['main.tex', originalMain],
      ['chapters/intro.tex', 'Intro content'],
      ['appendix.tex', 'Appendix content'],
    ]);

    const writes = new Map<string, string>();

    const originalRead = flexibleFS.read;
    const originalWrite = flexibleFS.write;

    try {
      (flexibleFS as unknown as { read: typeof flexibleFS.read }).read =
        (async (target: string) =>
          files.get(target) ?? '') as typeof flexibleFS.read;

      (flexibleFS as unknown as { write: typeof flexibleFS.write }).write =
        (async (target: string, content: string | Uint8Array) => {
          const resolved =
            typeof content === 'string'
              ? content
              : Buffer.from(content).toString('utf-8');
          writes.set(target, resolved);
          files.set(target, resolved);
        }) as typeof flexibleFS.write;

      await replaceInputCommands(baseFiles, outputFiles);

      const updatedMain = writes.get('main.tex');
      assert.ok(updatedMain, 'expected main.tex to be rewritten');
      assert.strictEqual(
        updatedMain,
        [
          '\\documentclass{article}',
          '\\input{chapters/intro.tex}',
          '\\input{appendix.tex}',
          '\\input{chapters/intro.tex}',
        ].join('\n'),
      );
    } finally {
      (flexibleFS as unknown as { read: typeof flexibleFS.read }).read =
        originalRead;
      (flexibleFS as unknown as { write: typeof flexibleFS.write }).write =
        originalWrite;
    }
  });
});
