declare module 'sortablejs' {
  export interface SortableOptions {
    animation?: number;
    group?: string | Record<string, unknown>;
    draggable?: string;
    handle?: string;
    onEnd?: (event: unknown) => void;
  }

  export default class Sortable {
    constructor(element: HTMLElement, options?: SortableOptions);
    destroy(): void;
  }
}
