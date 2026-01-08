// Local imports - memory view

export class MemoryViewState {
  constructor() {
    this.items = [];
  }

  initialize() {
    this.items = [];
  }

  setItems(items) {
    this.items = Array.isArray(items) ? items : [];
  }

  getItems() {
    return this.items;
  }
}

export const memoryViewState = new MemoryViewState();
