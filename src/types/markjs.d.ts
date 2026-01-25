export {};

declare global {
  class Mark {
    constructor(context: Element | DocumentFragment);
    mark(term: string, options: { each?: () => void; done?: () => void }): void;
    unmark(options?: { done?: () => void }): void;
  }
}
