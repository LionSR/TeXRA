import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
}));

vi.mock('@utils/files/workspaceFS', async () => {
  const actual = await vi.importActual<
    typeof import('@utils/files/workspaceFS')
  >('@utils/files/workspaceFS');
  return {
    ...actual,
    WorkspaceFS: {
      ...actual.WorkspaceFS,
      read: mocks.read,
      // getPromptFileName falls back to the basename when locatePath throws,
      // which keeps these assertions independent of host workspace state.
      locatePath: () => {
        throw new Error('no workspace in test');
      },
    },
  };
});

import { getXmlFormatFromReadableFiles } from '@utils/prompt';

beforeEach(() => {
  mocks.read.mockReset();
});

describe('getXmlFormatFromReadableFiles', () => {
  it('returns null xml when given no files', async () => {
    expect((await getXmlFormatFromReadableFiles([])).xml).toBeNull();
  });

  it('wraps every readable file in a <document> block', async () => {
    mocks.read.mockImplementation(async (file: string) => `body of ${file}`);

    const { xml } = await getXmlFormatFromReadableFiles(['a.tex', 'b.tex']);

    expect(xml).toBe(
      '<document name="a.tex">\nbody of a.tex\n</document>\n' +
        '<document name="b.tex">\nbody of b.tex\n</document>',
    );
  });

  it('skips a file that cannot be read instead of rejecting the batch, and reports the same readable file set used to build XML', async () => {
    // Reads return the file body, except 'missing.tex' which rejects with
    // ENOENT.
    mocks.read.mockImplementation(async (file: string) => {
      if (file === 'missing.tex') {
        throw new Error(
          "ENOENT: no such file or directory, open 'missing.tex'",
        );
      }
      return `body of ${file}`;
    });

    const result = await getXmlFormatFromReadableFiles([
      'missing.tex',
      'present.tex',
    ]);

    expect(result).toEqual({
      xml: '<document name="present.tex">\nbody of present.tex\n</document>',
      readableFiles: ['present.tex'],
    });
  });

  it('returns null xml when none of the files are readable', async () => {
    mocks.read.mockRejectedValue(new Error('ENOENT'));

    expect(
      (await getXmlFormatFromReadableFiles(['gone-1.tex', 'gone-2.tex'])).xml,
    ).toBeNull();
  });
});
