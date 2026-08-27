export interface UnsavedChangesEditor {
  hasUnsavedChanges(): boolean;
}

interface BeforeUnloadEventLike {
  preventDefault(): void;
  returnValue: string;
}

interface BeforeUnloadWindow {
  addEventListener(
    type: 'beforeunload',
    listener: (event: BeforeUnloadEventLike) => void,
  ): void;
}

function installUnsavedCloseVeto(
  window: BeforeUnloadWindow,
  editor: UnsavedChangesEditor,
): void {
  window.addEventListener('beforeunload', (event) => {
    if (!editor.hasUnsavedChanges()) return;
    event.preventDefault();
    event.returnValue = '';
  });
}

export function installDesktopUnsavedCloseWiring(
  window: BeforeUnloadWindow,
  editor: UnsavedChangesEditor,
): void {
  installUnsavedCloseVeto(window, editor);
}
