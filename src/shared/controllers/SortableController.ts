/**
 * Lit reactive controller for managing Sortable.js drag-and-drop reordering.
 *
 * Encapsulates Sortable.js lifecycle management and provides a clean interface
 * for file list reordering in Lit components.
 */

// Third-party imports
import Sortable from 'sortablejs';
import type { ReactiveController, ReactiveControllerHost } from 'lit';

// Local imports - shared types
import type { SortableDragEvent } from '@shared/types/sortable';

export interface SortableControllerConfig {
  /** Animation duration in ms (default: 150) */
  animation?: number;
}

export interface SortableReorderResult {
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
export type SortableReorderCallback = (result: SortableReorderResult) => void;

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

  hostConnected(): void {
    // Sortable is initialized lazily in hostUpdated after DOM is ready
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
      onEnd: (event) => this.handleSortEnd(event),
    });
  }

  private destroy(): void {
    this.sortable?.destroy();
    this.sortable = null;
  }

  private handleSortEnd(event: unknown): void {
    const { oldIndex, newIndex } = (event ?? {}) as SortableDragEvent;
    if (
      oldIndex === null ||
      oldIndex === undefined ||
      newIndex === null ||
      newIndex === undefined
    ) {
      return;
    }

    const current = [...this.getItems()];
    const [moved] = current.splice(oldIndex, 1);
    current.splice(newIndex, 0, moved);

    this.onReorder({
      oldIndex,
      newIndex,
      items: current,
    });
  }
}
