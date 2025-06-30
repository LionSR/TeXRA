// Local imports

/**
 * Manages stream tab UI updates.
 */
export class StreamTabs {
  /**
   * Updates UI to show stream tabs and highlight the active stream
   * @param {Array} streams - Array of stream names
   * @param {string} activeStream - Currently active stream
   */
  update(streams, activeStream) {
    if (!Array.isArray(streams)) {
      console.error('StreamTabs.update: streams must be an array');
      return;
    }
    const tabsContainer = document.getElementById('streamTabs');
    if (!tabsContainer) {
      console.error('StreamTabs.update: streamTabs container not found');
      return;
    }
    tabsContainer.innerHTML = streams
      .map((stream) => {
        if (!stream || typeof stream !== 'object') {
          console.warn('StreamTabs.update: invalid stream value:', stream);
          return '';
        }
        return `<div class="tab-container ${stream.id === activeStream ? 'active' : ''}" title="${stream.name}">
            <button class="tab" data-stream="${stream.id}" title="${stream.name}">${stream.name}</button>
            <button class="tab-delete" data-stream="${stream.id}" title="Delete stream">
              <i class="codicon codicon-close"></i>
            </button>
          </div>`;
      })
      .join('');

    // Update current stream name
    const streamNameElem = document.getElementById('currentStreamName');
    if (streamNameElem) {
      const active = streams.find((s) => s.id === activeStream);
      streamNameElem.textContent = active ? active.name : '';
    }
  }
}
