// Standard library imports
import { strict as assert } from 'assert';

// Local imports
import { replaceInputCommands, flexibleFS } from '@utils/files';

describe('replaceInputCommands', () => {
  const originalRead = flexibleFS.read;
  const originalWrite = flexibleFS.write;

  afterEach(() => {
    (flexibleFS as unknown as { read: typeof flexibleFS.read }).read =
      originalRead;
    (flexibleFS as unknown as { write: typeof flexibleFS.write }).write =
      originalWrite;
  });

  it('preserves directory prefixes and extensionless inputs when rewriting', async () => {
    const files = new Map<string, string>([
      ['/tmp/output/main.tex', '\\input{sections/intro}'],
      ['/tmp/output/sections/intro_r2.tex', '\\section{Intro}'],
    ]);
    const writes: Array<{ target: string; content: string }> = [];

    (flexibleFS as unknown as { read: typeof flexibleFS.read }).read = async (
      target: string,
    ) => {
      const content = files.get(target);
      if (content === undefined) {
        throw new Error(`Unexpected read: ${target}`);
      }
      return content;
    };

    (flexibleFS as unknown as { write: typeof flexibleFS.write }).write =
      async (target: string, content: string | Uint8Array) => {
        const resolved =
          typeof content === 'string'
            ? content
            : Buffer.from(content).toString('utf-8');
        writes.push({ target, content: resolved });
        files.set(target, resolved);
      };

    await replaceInputCommands(
      ['/tmp/base/main.tex', '/tmp/base/sections/intro.tex'],
      ['/tmp/output/main.tex', '/tmp/output/sections/intro_r2.tex'],
    );

    assert.deepEqual(writes, [
      {
        target: '/tmp/output/main.tex',
        content: '\\input{sections/intro_r2}',
      },
    ]);
  });

  it('updates explicit .tex inputs while keeping directory prefixes', async () => {
    const files = new Map<string, string>([
      ['/tmp/output/main.tex', '\\input{sections/intro.tex}'],
      ['/tmp/output/sections/intro_r2.tex', '\\section{Intro}'],
    ]);
    const writes: Array<{ target: string; content: string }> = [];

    (flexibleFS as unknown as { read: typeof flexibleFS.read }).read = async (
      target: string,
    ) => {
      const content = files.get(target);
      if (content === undefined) {
        throw new Error(`Unexpected read: ${target}`);
      }
      return content;
    };

    (flexibleFS as unknown as { write: typeof flexibleFS.write }).write =
      async (target: string, content: string | Uint8Array) => {
        const resolved =
          typeof content === 'string'
            ? content
            : Buffer.from(content).toString('utf-8');
        writes.push({ target, content: resolved });
        files.set(target, resolved);
      };

    await replaceInputCommands(
      ['/tmp/base/main.tex', '/tmp/base/sections/intro.tex'],
      ['/tmp/output/main.tex', '/tmp/output/sections/intro_r2.tex'],
    );

    assert.deepEqual(writes, [
      {
        target: '/tmp/output/main.tex',
        content: '\\input{sections/intro_r2.tex}',
      },
    ]);
  });
});
