import { vscode } from './vscodeApi.js';

// Track search state
let markInstance;
let currentIndex = -1;
let totalMatches = 0;

/**
 * Render the list of history items
 */
export function renderHistoryItems(historyItems) {
  const historyContainer = document.getElementById('historyContainer');
  const clearButtonContainer = document.getElementById('clearButtonContainer');

  // Clear existing content
  historyContainer.innerHTML = '';
  clearButtonContainer.innerHTML = '';

  // Handle empty history state
  if (!historyItems || historyItems.length === 0) {
    historyContainer.innerHTML =
      '<div class="empty-state">No history items found</div>';
    return;
  }

  // Add clear button
  clearButtonContainer.innerHTML = `
    <button class="button button-clear" id="clearHistoryBtn">Clear All History</button>
  `;

  // Add event listener for clear button
  document.getElementById('clearHistoryBtn').addEventListener('click', () => {
    vscode.postMessage({ command: 'clearHistory' });
  });

  // Sort items by timestamp (newest first)
  const sortedItems = [...historyItems].sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
  );

  // Render each history item
  sortedItems.forEach((item) => {
    const historyItemElement = createHistoryItemElement(item);
    historyContainer.appendChild(historyItemElement);
  });

  // Setup event listeners for the newly created elements
  setupItemEventListeners();

  // Initialize mark.js on the container
  markInstance = new Mark(historyContainer);
}

/**
 * Create a history item DOM element
 */
function createHistoryItemElement(item) {
  const config = item.config;
  const date = new Date(item.timestamp);
  const formattedDate = date.toLocaleString();

  // Create the container element
  const container = document.createElement('div');
  container.className = 'history-item';

  // Create the header (timestamp + rerun button)
  const header = document.createElement('div');
  header.className = 'history-item-header';
  header.innerHTML = `
    <div class="history-timestamp">${formattedDate}</div>
    <div class="history-actions button-group">
      <button class="button delete-btn" data-id="${item.id}" title="Delete this history item">Delete</button>
      <button class="button restore-btn" data-id="${item.id}" title="Load configuration to main view">Restore</button>
      <button class="button rerun-btn" data-id="${item.id}" title="Execute this configuration">Rerun</button>
    </div>
  `;

  // Create the basic details section
  const basicDetails = document.createElement('div');
  basicDetails.className = 'history-details';

  // Build basic details HTML with agent, model, and instruction
  let basicDetailsHTML = `
    <span class="history-label">Agent:</span>
    <span class="history-value">${config.agent}</span>
    
    <span class="history-label">Model:</span>
    <span class="history-value">${config.model}</span>
    
    <span class="history-label">Instruction:</span>
    <span class="history-value">${config.instruction || 'None'}</span>
  `;

  // Define file types to show in basic details
  const basicFileTypes = [
    { type: 'input', singular: 'InputFile', plural: 'InputFiles' },
    { type: 'media', singular: 'MediaFile', plural: 'MediaFiles' },
  ];

  // Add file information to basic details
  basicFileTypes.forEach(({ type, singular, plural }) => {
    const singleFile = config[`${type}File`];
    const multipleFiles = config[`${type}Files`];

    // Always show single file first if it exists
    if (singleFile) {
      basicDetailsHTML += `
        <span class="history-label">${singular}:</span>
        <span class="history-value">${singleFile}</span>
      `;
    } else if (type === 'input') {
      // Always show input file even if none
      basicDetailsHTML += `
        <span class="history-label">${singular}:</span>
        <span class="history-value">None</span>
      `;
    }

    // Also show multiple files if they exist
    if (multipleFiles && multipleFiles.length > 0) {
      basicDetailsHTML += `
        <span class="history-label">${plural}:</span>
        <span class="history-value">${multipleFiles.join(', ')}</span>
      `;
    }
  });

  basicDetails.innerHTML = basicDetailsHTML;

  // Create the collapsible details section
  const collapsibleDetails = document.createElement('div');
  collapsibleDetails.className = 'collapsible';
  collapsibleDetails.id = `content-${item.id}`;

  const detailsContainer = document.createElement('div');
  detailsContainer.className = 'history-details';

  // Build the collapsible details HTML
  let detailsHTML = '';

  // Define file types for collapsible section
  const collapsibleFileTypes = [
    { type: 'reference', singular: 'ReferenceFile', plural: 'ReferenceFiles' },
    { type: 'auxiliary', singular: 'AuxiliaryFile', plural: 'AuxiliaryFiles' },
  ];

  // Add file information to collapsible details
  collapsibleFileTypes.forEach(({ type, singular, plural }) => {
    const singleFile = config[`${type}File`];
    const multipleFiles = config[`${type}Files`];

    // Always show single file first if it exists
    if (singleFile) {
      detailsHTML += `
        <span class="history-label">${singular}:</span>
        <span class="history-value">${singleFile}</span>
      `;
    }

    // Also show multiple files if they exist
    if (multipleFiles && multipleFiles.length > 0) {
      detailsHTML += `
        <span class="history-label">${plural}:</span>
        <span class="history-value">${multipleFiles.join(', ')}</span>
      `;
    }
  });

  // Add output files
  if (config.outputFiles && config.outputFiles.length > 0) {
    detailsHTML += `
      <span class="history-label">Output Files:</span>
      <span class="history-value">${config.outputFiles.join(', ')}</span>
    `;
  }

  // Add output name override
  if (config.outputNameOverride) {
    detailsHTML += `
      <span class="history-label">Output Name:</span>
      <span class="history-value">${config.outputNameOverride}</span>
    `;
  }

  // Add tool config section
  if (config.toolConfig) {
    detailsHTML += renderToolConfig(
      '<i class="codicon codicon-tools"></i> Config',
      config.toolConfig,
    );
  }

  // Only create the collapsible section if there are details to show
  if (detailsHTML) {
    detailsContainer.innerHTML = detailsHTML;
    collapsibleDetails.appendChild(detailsContainer);

    // Create the toggle button
    const toggleButton = document.createElement('button');
    toggleButton.className = 'toggle-button';
    toggleButton.setAttribute('data-id', item.id);
    toggleButton.textContent = 'Show more';

    // Assemble the full history item
    container.appendChild(header);
    container.appendChild(basicDetails);
    container.appendChild(collapsibleDetails);
    container.appendChild(toggleButton);
  } else {
    // If no additional details, just add the basic info
    container.appendChild(header);
    container.appendChild(basicDetails);
  }

  return container;
}

/**
 * Render a configuration section
 */
function renderToolConfig(label, obj, exclude = []) {
  if (!obj) return '';

  const entries = Object.entries(obj).filter(([key, value]) => {
    // Filter out null, undefined, empty arrays, and excluded keys
    if (exclude.includes(key)) return false;
    if (value == null) return false;
    if (Array.isArray(value) && value.length === 0) return false;
    return true;
  });

  if (entries.length === 0) return '';

  let html = `
    <span class="history-label">${label}:</span>
    <div class="history-value config-section">
  `;

  entries.forEach(([key, value]) => {
    // Format arrays nicely
    const displayValue = Array.isArray(value)
      ? value.join(', ')
      : typeof value === 'boolean'
        ? value
          ? 'Yes'
          : 'No'
        : value;

    html += `<div class="config-item"><span class="config-key">${key}:</span> ${displayValue}</div>`;
  });

  html += `</div>`;

  return html;
}

/**
 * Set up event listeners for the history items
 */
function setupItemEventListeners() {
  // Handle rerun buttons
  document.querySelectorAll('.rerun-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const historyId = btn.getAttribute('data-id');
      vscode.postMessage({
        command: 'rerunAgent',
        historyId: historyId,
      });
    });
  });

  // Handle restore buttons
  document.querySelectorAll('.restore-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const historyId = btn.getAttribute('data-id');
      vscode.postMessage({
        command: 'restoreAgent',
        historyId: historyId,
      });
    });
  });

  // Handle delete buttons
  document.querySelectorAll('.delete-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const historyId = btn.getAttribute('data-id');
      vscode.postMessage({
        command: 'deleteAgent',
        historyId: historyId,
      });
    });
  });

  // Handle collapse/expand
  document.querySelectorAll('.toggle-button').forEach((btn) => {
    btn.addEventListener('click', () => {
      const itemId = btn.getAttribute('data-id');
      const content = document.getElementById('content-' + itemId);
      content.classList.toggle('expanded');
      btn.textContent = content.classList.contains('expanded')
        ? 'Show less'
        : 'Show more';
    });
  });
}

/**
 * Set up global event listeners
 */
export function setupEventListeners() {
  // Set up search functionality
  const searchInput = document.getElementById('searchInput');
  const prevMatchBtn = document.getElementById('prevMatch');
  const nextMatchBtn = document.getElementById('nextMatch');

  // Add input event listener for search
  searchInput.addEventListener('input', (event) => {
    const searchTerm = event.target.value.trim();

    // Clear existing marks
    markInstance.unmark({
      done: () => {
        if (searchTerm) {
          // Reset state
          currentIndex = -1;
          totalMatches = 0;

          // Expand all collapsible sections for better searching
          expandAllCollapsibleSections();

          // Perform search with mark.js
          markInstance.mark(searchTerm, {
            each: (element) => {
              // Count total matches
              totalMatches++;
            },
            done: () => {
              // Update counts and navigate to first match if found
              updateMatchCount(totalMatches, totalMatches > 0 ? 1 : 0);
              if (totalMatches > 0) {
                currentIndex = 0;
                scrollToCurrentMatch();
              }
            },
          });
        } else {
          // No search term, reset the counter
          updateMatchCount(0, 0);
        }
      },
    });
  });

  // Add click listeners for navigation buttons
  prevMatchBtn.addEventListener('click', () => {
    navigateToPrevMatch();
  });

  nextMatchBtn.addEventListener('click', () => {
    navigateToNextMatch();
  });

  // Add key event listener for Enter key to navigate to next match
  searchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      if (event.shiftKey) {
        navigateToPrevMatch();
      } else {
        navigateToNextMatch();
      }
    }
  });
}

/**
 * Navigate to the next match
 */
function navigateToNextMatch() {
  if (totalMatches === 0) return;

  // Remove current class from current match if it exists
  const currentMatch = document.querySelector('mark.current-match');
  if (currentMatch) {
    currentMatch.classList.remove('current-match');
  }

  // Update index (with wrap-around)
  currentIndex = (currentIndex + 1) % totalMatches;

  // Update display and scroll to match
  scrollToCurrentMatch();
}

/**
 * Navigate to the previous match
 */
function navigateToPrevMatch() {
  if (totalMatches === 0) return;

  // Remove current class from current match if it exists
  const currentMatch = document.querySelector('mark.current-match');
  if (currentMatch) {
    currentMatch.classList.remove('current-match');
  }

  // Update index (with wrap-around)
  currentIndex = (currentIndex - 1 + totalMatches) % totalMatches;

  // Update display and scroll to match
  scrollToCurrentMatch();
}

/**
 * Scroll to and highlight the current match
 */
function scrollToCurrentMatch() {
  if (totalMatches === 0) return;

  const marks = document.querySelectorAll('mark');
  if (marks.length > currentIndex) {
    // Add current class to this match
    marks[currentIndex].classList.add('current-match');

    // Scroll to the match
    marks[currentIndex].scrollIntoView({
      behavior: 'smooth',
      block: 'center',
    });

    // Update count display
    updateMatchCount(totalMatches, currentIndex + 1);
  }
}

/**
 * Update the match count display
 */
function updateMatchCount(total, current) {
  const matchCountEl = document.getElementById('matchCount');
  if (total === 0) {
    matchCountEl.textContent = '';
  } else {
    matchCountEl.textContent = `${current}/${total}`;
  }
}

/**
 * Expand all collapsible sections
 */
function expandAllCollapsibleSections() {
  document.querySelectorAll('.collapsible').forEach((section) => {
    if (!section.classList.contains('expanded')) {
      section.classList.add('expanded');

      // Also update the corresponding toggle button
      const itemId = section.id.replace('content-', '');
      const toggleBtn = document.querySelector(
        `.toggle-button[data-id="${itemId}"]`,
      );

      if (toggleBtn) {
        toggleBtn.textContent = 'Show less';
      }
    }
  });
}
