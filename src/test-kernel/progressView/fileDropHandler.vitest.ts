// Third-party imports
import { describe, expect, it, vi } from 'vitest';
import { FileDropController } from '@progressView/frontend/fileDropHandler';

describe('FileDropController', () => {
  it('preserves hosts when extracting UNC-style file URIs', () => {
    const onDrop = vi.fn<(paths: string[]) => void>();
    const controller = new FileDropController(
      {
        addController: () => {},
        removeController: () => {},
        requestUpdate: () => {},
        updateComplete: Promise.resolve(true),
      },
      onDrop,
    );
    const data: Record<string, string> = {
      'text/uri-list': 'file://server/share/main.tex',
    };

    controller.handleDrop({
      dataTransfer: {
        types: ['text/uri-list'],
        files: [],
        getData: (type: string) => data[type] ?? '',
      },
      preventDefault: () => {},
    } as unknown as DragEvent);

    expect(onDrop).toHaveBeenCalledWith(['//server/share/main.tex']);
  });
});
