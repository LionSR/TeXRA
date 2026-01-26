// Local imports - shared state
import { ToggleStateStore } from '@shared/state/ToggleStateStore';

type ToggleListener = (event: Event) => void;

type GroupElements = Map<string, HTMLElement>;

/**
 * Tracks task group toggle state and synchronizes it with DOM elements.
 */
export class TaskGroupStateManager {
  private toggleStates: ToggleStateStore;
  private toggleListeners: Map<string, ToggleListener>;

  constructor(toggleStates?: ToggleStateStore) {
    this.toggleStates = toggleStates ?? new ToggleStateStore();
    this.toggleListeners = new Map();
  }

  applyToggleState(groupId: string, detailsElem: HTMLDetailsElement): void {
    const isCollapsed = this.toggleStates.get(groupId) === true;
    detailsElem.open = !isCollapsed;

    const toggleListener: ToggleListener = () => {
      this.toggleStates.set(groupId, !detailsElem.open);
    };
    detailsElem.addEventListener('toggle', toggleListener);
    this.toggleListeners.set(groupId, toggleListener);
  }

  setCollapsed(groupId: string, isCollapsed: boolean): void {
    this.toggleStates.set(groupId, isCollapsed);
  }

  removeToggleListener(groupId: string, element: HTMLElement | null): void {
    const listener = this.toggleListeners.get(groupId);
    if (listener && element) {
      element.removeEventListener('toggle', listener);
    }
    this.toggleListeners.delete(groupId);
  }

  clear(groupElements: GroupElements): void {
    for (const [groupId, element] of groupElements.entries()) {
      this.removeToggleListener(groupId, element);
    }
    this.toggleListeners.clear();
  }
}
