// Third-party imports
import { describe, expect, it, vi } from 'vitest';
import { FileDropController } from '@webview/frontend/fileDropHandler';
import type { ReactiveControllerHost } from 'lit';

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
  const host: ReactiveControllerHost = {
    addController: () => {},
    removeController: () => {},
    requestUpdate: () => {},
    updateComplete: Promise.resolve(true),
  };
  const onDrop = vi.fn<(paths: string[]) => void>();
  return { controller: new FileDropController(host, onDrop), onDrop };
}

describe('FileDropController', () => {
  it('activates for file payloads without treating plain text as a file', () => {
    const { controller } = createDropTarget();

    const filesEvent = dragEvent(dataTransfer(['Files']));
    controller.handleDragEnter(filesEvent);
    expect(controller.isDragActive).toBe(true);
    expect(filesEvent.preventDefault).toHaveBeenCalled();

    const uriEvent = dragEvent(
      dataTransfer(['text/uri-list'], {
        'text/uri-list': 'file:///Users/a/project/main.tex',
      }),
    );
    controller.handleDragEnter(uriEvent);
    expect(uriEvent.preventDefault).toHaveBeenCalled();

    const textEvent = dragEvent(dataTransfer(['text/plain']));
    controller.handleDragEnter(textEvent);
    expect(textEvent.preventDefault).not.toHaveBeenCalled();

    const linkEvent = dragEvent(
      dataTransfer(['text/uri-list'], {
        'text/uri-list': 'https://example.com/paper',
      }),
    );
    controller.handleDragEnter(linkEvent);
    expect(linkEvent.preventDefault).not.toHaveBeenCalled();
  });

  it('accepts a uri-list payload during dragover when the data store is protected', () => {
    const { controller } = createDropTarget();

    // While dragging, `getData()` returns '' (protected mode); only `types` is
    // readable. The payload must still count as droppable so the handler calls
    // preventDefault() and the drop event can fire.
    const event = dragEvent(dataTransfer(['text/uri-list']));
    controller.handleDragOver(event);

    expect(event.preventDefault).toHaveBeenCalled();
  });

  it('extracts file paths from dropped File objects', () => {
    const { controller, onDrop } = createDropTarget();

    controller.handleDrop(
      dragEvent(
        dataTransfer(['Files'], {}, [{ path: '/Users/a/project/main.tex' }]),
      ),
    );

    expect(onDrop).toHaveBeenCalledWith(['/Users/a/project/main.tex']);
  });

  it('extracts and deduplicates file URIs from text payloads', () => {
    const { controller, onDrop } = createDropTarget();

    controller.handleDrop(
      dragEvent(
        dataTransfer(['text/uri-list'], {
          'text/uri-list': [
            'file:///Users/a/project/My%20Paper/main.tex',
            '# Finder comment',
            'file:///Users/a/project/refs.bib',
            'file:///Users/a/project/refs.bib',
          ].join('\n'),
        }),
      ),
    );

    expect(onDrop).toHaveBeenCalledWith([
      '/Users/a/project/My Paper/main.tex',
      '/Users/a/project/refs.bib',
    ]);
  });

  it('ignores malformed percent-encoded file URIs', () => {
    const { controller, onDrop } = createDropTarget();
    const transfer = dataTransfer(['text/uri-list'], {
      'text/uri-list': 'file:///tmp/%E0%A4%A',
    });

    const enterEvent = dragEvent(transfer);
    controller.handleDragEnter(enterEvent);
    expect(controller.isDragActive).toBe(false);
    expect(enterEvent.preventDefault).not.toHaveBeenCalled();

    const dropEvent = dragEvent(transfer);
    controller.handleDrop(dropEvent);
    expect(onDrop).not.toHaveBeenCalled();
    expect(dropEvent.preventDefault).not.toHaveBeenCalled();
  });

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
