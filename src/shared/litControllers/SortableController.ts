// Third-party imports
import Sortable from 'sortablejs';
import type { ReactiveController, ReactiveControllerHost } from 'lit';

interface SortableReorderResult {
  /** Original index before drag */
  oldIndex: number;
  /** New index after drop */
  newIndex: number;
  /** Reordered items array */
  items: string[];
}

/**
 * Callback invoked when items are reordered via drag-and-drop.
 * @param result - Contains oldIndex, newIndex, and the reordered items array
 */
type SortableReorderCallback = (result: SortableReorderResult) => void;

/**
 * Lit reactive controller for managing Sortable.js on a file list element.
 *
 * Usage:
 * ```typescript
 * // In host component
 * private sortableController = new SortableController(
 *   this,
 *   () => this.fileListElement,
 *   () => this.currentFiles,
 *   (result) => this.dispatchEvent(
 *     MainViewEvents.filesReordered({ listId: this.listId, files: result.items })
 *   ),
 * );
 * ```
 */
export class SortableController implements ReactiveController {
  private sortable: Sortable | null = null;

  constructor(
    private readonly host: ReactiveControllerHost,
    private readonly getElement: () => HTMLElement | undefined,
    private readonly getItems: () => string[],
    private readonly onReorder: SortableReorderCallback,
  ) {
    this.host.addController(this);
  }

  hostUpdated(): void {
    this.initialize();
  }

  hostDisconnected(): void {
    this.destroy();
  }

  private initialize(): void {
    if (this.sortable) return;

    const element = this.getElement();
    if (!element) return;

    this.sortable = new Sortable(element, {
      animation: 150,
      onEnd: ({ oldIndex, newIndex }) => this.handleSortEnd(oldIndex, newIndex),
    });
  }

  private destroy(): void {
    this.sortable?.destroy();
    this.sortable = null;
  }

  private handleSortEnd(oldIndex?: number, newIndex?: number): void {
    if (oldIndex === undefined || newIndex === undefined) {
      return;
    }

    const items = [...this.getItems()];
    const [moved] = items.splice(oldIndex, 1);
    items.splice(newIndex, 0, moved);

    this.onReorder({ oldIndex, newIndex, items });
  }
}
