// Third-party imports
import Sortable from 'sortablejs';
import type { ReactiveController, ReactiveControllerHost } from 'lit';

interface SortableControllerConfig {
  /** Animation duration in ms (default: 150) */
  animation?: number;
}

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
 *
 * protected override updated(changedProps: Map<string, unknown>): void {
 *   if (changedProps.has('config')) {
 *     this.sortableController.reinitialize();
 *   }
 * }
 * ```
 */
export class SortableController implements ReactiveController {
  private sortable: Sortable | null = null;
  private readonly config: Required<SortableControllerConfig>;

  constructor(
    private readonly host: ReactiveControllerHost,
    private readonly getElement: () => HTMLElement | undefined,
    private readonly getItems: () => string[],
    private readonly onReorder: SortableReorderCallback,
    config: SortableControllerConfig = {},
  ) {
    this.config = {
      animation: config.animation ?? 150,
    };
    this.host.addController(this);
  }

  hostUpdated(): void {
    this.initialize();
  }

  hostDisconnected(): void {
    this.destroy();
  }

  /**
   * Force reinitialization of Sortable (e.g., when config changes).
   * Call this from the host's updated() when relevant properties change.
   */
  reinitialize(): void {
    this.destroy();
    // Will be initialized on next hostUpdated call
  }

  private initialize(): void {
    if (this.sortable) return;

    const element = this.getElement();
    if (!element) return;

    this.sortable = new Sortable(element, {
      animation: this.config.animation,
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
