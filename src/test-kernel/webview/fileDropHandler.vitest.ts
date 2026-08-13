import { describe, expect, it } from 'vitest';

import {
  extractDroppedFilePaths,
  hasDroppedFilePayload,
} from '@webview/frontend/fileDropHandler';

type FakeFile = {
  path?: string;
};

function dataTransfer(
  types: string[],
  data: Record<string, string> = {},
  files: FakeFile[] = [],
): DataTransfer {
  return {
    types,
    files,
    getData: (type: string) => data[type] ?? '',
  } as unknown as DataTransfer;
}

describe('fileDropHandler', () => {
  it('detects file drop payloads without treating plain text as a file', () => {
    expect(hasDroppedFilePayload(dataTransfer(['Files']))).toBe(true);
    expect(
      hasDroppedFilePayload(
        dataTransfer(['text/uri-list'], {
          'text/uri-list': 'file:///Users/a/project/main.tex',
        }),
      ),
    ).toBe(true);
    expect(hasDroppedFilePayload(dataTransfer(['text/plain']))).toBe(false);
    expect(
      hasDroppedFilePayload(
        dataTransfer(['text/uri-list'], {
          'text/uri-list': 'https://example.com/paper',
        }),
      ),
    ).toBe(false);
  });

  it('accepts a uri-list payload during dragover when the data store is protected', () => {
    // While dragging, `getData()` returns '' (protected mode); only `types` is
    // readable. We must still report the payload as droppable so the dragover
    // handler calls preventDefault() and the drop event can fire.
    expect(hasDroppedFilePayload(dataTransfer(['text/uri-list']))).toBe(true);
  });

  it('extracts file paths from dropped File objects', () => {
    const paths = extractDroppedFilePaths(
      dataTransfer(['Files'], {}, [{ path: '/Users/a/project/main.tex' }]),
    );

    expect(paths).toEqual(['/Users/a/project/main.tex']);
  });

  it('extracts and deduplicates file URIs from text payloads', () => {
    const paths = extractDroppedFilePaths(
      dataTransfer(['text/uri-list'], {
        'text/uri-list': [
          'file:///Users/a/project/My%20Paper/main.tex',
          '# Finder comment',
          'file:///Users/a/project/refs.bib',
          'file:///Users/a/project/refs.bib',
        ].join('\n'),
      }),
    );

    expect(paths).toEqual([
      '/Users/a/project/My Paper/main.tex',
      '/Users/a/project/refs.bib',
    ]);
  });

  it('ignores malformed percent-encoded file URIs', () => {
    const transfer = dataTransfer(['text/uri-list'], {
      'text/uri-list': 'file:///tmp/%E0%A4%A',
    });

    expect(hasDroppedFilePayload(transfer)).toBe(false);
    expect(extractDroppedFilePaths(transfer)).toEqual([]);
  });

  it('preserves hosts when extracting UNC-style file URIs', () => {
    const paths = extractDroppedFilePaths(
      dataTransfer(['text/uri-list'], {
        'text/uri-list': 'file://server/share/main.tex',
      }),
    );

    expect(paths).toEqual(['//server/share/main.tex']);
  });
});
