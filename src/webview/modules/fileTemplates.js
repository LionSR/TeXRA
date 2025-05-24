// Local imports - utils
import { FILE_TYPES } from './constants.js';
import { capitalize } from './stringUtils.js';

const ICONS = {
  input: 'file-code',
  reference: 'book',
  auxiliary: 'file-add',
  media: 'file-media',
};

const LABELS = {
  input: 'Input',
  reference: 'Reference',
  auxiliary: 'Auxiliary',
  media: 'Media',
};

function createBlock(type) {
  const icon = ICONS[type] || 'file';
  const label = LABELS[type] || capitalize(type);
  const cap = capitalize(type);
  const hasCurrent = ['input', 'reference', 'auxiliary'].includes(type);
  const hasAddOpened = hasCurrent;
  const hasAutoExtract = type === 'media';
  return `
  <div class="file-select">
    <div class="file-select-header">
      <div class="file-select-label-group">
        <label for="${type}File"><i class="codicon codicon-${icon} clickable" title="${label} (Click to refresh)"></i> ${label}</label>
        ${
          hasAutoExtract
            ? `<div class="dropdown-container dropdown-left">
          <span id="toggleAutoExtract" class="auto-toggle" title="Auto-extract options">
            <i class="codicon codicon-wand"></i><i class="codicon codicon-chevron-down"></i>
          </span>
          <div id="autoExtractOptions" class="dropdown-options" style="display: none">
            <label class="vscode-checkbox"><input type="checkbox" id="autoExtractFigure" /><i class="codicon codicon-file-media"></i>Figures</label>
            <label class="vscode-checkbox"><input type="checkbox" id="autoExtractTikzFigure" /><i class="codicon codicon-file-code"></i>TikZ Figures</label>
          </div>
        </div>`
            : ''
        }
      </div>
      <div class="file-select-actions button-group">
        ${
          hasCurrent
            ? `<button id="current${cap}FileButton" class="vscode-button" title="Set current file as ${type}" data-action="current-file" data-filetype="${type}">
          <i class="codicon codicon-file-code"></i>
        </button>`
            : ''
        }
        <button id="empty${cap}FileButton" class="vscode-button" title="Empty" data-action="clear-single" data-filetype="${type}">
          <i class="codicon codicon-close"></i>
        </button>
        <span id="toggle${cap}Files" class="toggle-icon" title="Multiple" data-action="toggle-multiple" data-filetype="${type}"><i class="codicon codicon-chevron-down"></i></span>
        ${
          hasAddOpened
            ? `<button id="addOpened${cap}FilesButton" class="vscode-button" title="Add opened files as ${type}" data-action="add-opened" data-filetype="${type}">
          <i class="codicon codicon-folder-opened"></i>
        </button>`
            : ''
        }
        <button id="empty${cap}FilesButton" class="vscode-button" title="Empty" data-action="clear-multiple" data-filetype="${type}">
          <i class="codicon codicon-trash"></i>
        </button>
        <button id="select${cap}FilesButton" class="vscode-button" title="Add" data-action="select-multiple" data-filetype="${type}">
          <i class="codicon codicon-add"></i>
        </button>
      </div>
    </div>
    <select id="${type}File">
      <option value="">None</option>
    </select>
    <div id="${type}FilesContainer" class="multiple-files-container" style="display: none">
      <div class="multiple-files-content">
        <div id="${type}Files" class="multiple-files-list"></div>
      </div>
    </div>
  </div>`;
}

export function insertFileSelectors(containerId = 'fileSelectionGroup') {
  const container = document.getElementById(containerId);
  if (!container) return;
  const types = FILE_TYPES.filter((t) => t !== 'output');
  container.innerHTML = types.map(createBlock).join('');
}
