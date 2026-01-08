// Local imports - memory view
import { MemoryEventsManager } from './uiManagers/MemoryEventsManager.js';
import { MemoryRenderer } from './uiManagers/MemoryRenderer.js';
import { memoryViewState } from './memoryViewState.js';
// Local imports - common
import { BaseDomHandler } from '@common/BaseDomHandler.js';

/**
 * DOM handler for memory view.
 * Coordinates events and rendering.
 */
class MemoryViewDomHandler extends BaseDomHandler {
  constructor() {
    super({
      events: new MemoryEventsManager(),
      renderer: new MemoryRenderer(memoryViewState),
    });
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
