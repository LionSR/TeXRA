import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
}));

vi.mock('@utils/files', async () => {
  const actual =
    await vi.importActual<typeof import('@utils/files')>('@utils/files');
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

// Imported after vi.mock so the mocked WorkspaceFS is in place.
// eslint-disable-next-line import/order
import { getXmlFormatFromFiles } from '@utils/prompt';

beforeEach(() => {
  mocks.read.mockReset();
});

describe('getXmlFormatFromFiles', () => {
  it('returns null when given no files', async () => {
    expect(await getXmlFormatFromFiles([])).toBeNull();
  });

  it('wraps every readable file in a <document> block', async () => {
    mocks.read.mockImplementation(async (file: string) => `body of ${file}`);

    const xml = await getXmlFormatFromFiles(['a.tex', 'b.tex']);

    expect(xml).toBe(
      '<document name="a.tex">\nbody of a.tex\n</document>\n' +
        '<document name="b.tex">\nbody of b.tex\n</document>',
    );
  });

  it('skips a file that cannot be read instead of rejecting the batch', async () => {
    mocks.read.mockImplementation(async (file: string) => {
      if (file === 'missing.tex') {
        throw new Error("ENOENT: no such file or directory, open 'missing.tex'");
      }
      return `body of ${file}`;
    });

    const xml = await getXmlFormatFromFiles(['missing.tex', 'present.tex']);

    expect(xml).toBe('<document name="present.tex">\nbody of present.tex\n</document>');
  });

  it('returns null when none of the files are readable', async () => {
    mocks.read.mockRejectedValue(new Error('ENOENT'));

    expect(await getXmlFormatFromFiles(['gone-1.tex', 'gone-2.tex'])).toBeNull();
  });
});
