// Local imports - memory view
import { MemoryEventsManager } from './uiManagers/MemoryEventsManager.js';
import { memoryRenderer } from './uiManagers/MemoryRenderer.js';
import { BaseDomHandler } from '@common/BaseDomHandler.js';

/**
 * DOM handler for memory view.
 * Coordinates events and rendering.
 */
class MemoryViewDomHandler extends BaseDomHandler {
  constructor() {
    super();
    this.events = new MemoryEventsManager();
    this.renderer = memoryRenderer;
  }

  /**
   * Render memory items to the DOM.
   * @param {Array} items - Memory items to render
   */
  renderMemoryItems(items) {
    this.renderer.render(items);
  }
}

export const memoryViewDomHandler = new MemoryViewDomHandler();
