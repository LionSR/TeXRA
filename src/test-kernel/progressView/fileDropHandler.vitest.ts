// Third-party imports
import { describe, expect, it, vi } from 'vitest';
import { FileDropController } from '@progressView/frontend/fileDropHandler';

// Local imports - component under test

type FakeFile = {
  path?: string;
};

type FakeDragEvent = DragEvent & {
  readonly preventDefault: ReturnType<typeof vi.fn>;
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

function dragEvent(transfer: DataTransfer): FakeDragEvent {
  return {
    dataTransfer: transfer,
    preventDefault: vi.fn(),
  } as unknown as FakeDragEvent;
}

function createDropTarget(): {
  controller: FileDropController;
  onDrop: ReturnType<typeof vi.fn<(paths: string[]) => void>>;
} {
  const host: ConstructorParameters<typeof FileDropController>[0] = {
    addController: () => {},
    removeController: () => {},
    requestUpdate: () => {},
    updateComplete: Promise.resolve(true),
  };
  const onDrop = vi.fn<(paths: string[]) => void>();
  return { controller: new FileDropController(host, onDrop), onDrop };
}

describe('FileDropController', () => {
  it('preserves hosts when extracting UNC-style file URIs', () => {
    const { controller, onDrop } = createDropTarget();

    controller.handleDrop(
      dragEvent(
        dataTransfer(['text/uri-list'], {
          'text/uri-list': 'file://server/share/main.tex',
        }),
      ),
    );

    expect(onDrop).toHaveBeenCalledWith(['//server/share/main.tex']);
  });
});
