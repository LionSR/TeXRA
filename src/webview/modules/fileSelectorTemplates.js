import { FILE_TYPES } from './constants.js';
import { capitalize } from './stringUtils.js';
import { renderTemplate } from './utils.js';

const CONFIG = {
  input: { label: 'Input', icon: 'file-code' },
  reference: { label: 'Reference', icon: 'book' },
  auxiliary: { label: 'Auxiliary', icon: 'file-add' },
};

function createFileSelector(type) {
  const cfg = CONFIG[type];
  const cap = capitalize(type);
  const element = renderTemplate('fileSelectorTemplate');
  if (!element) return null;

  const labelEl = element.querySelector('label');
  if (labelEl) {
    labelEl.setAttribute('for', `${type}File`);
    const iconEl = element.querySelector('.file-icon');
    if (iconEl) {
      iconEl.classList.add(`codicon-${cfg.icon}`);
      iconEl.title = `${cfg.label} (Click to refresh)`;
    }
    const labelSpan = element.querySelector('.file-label');
    if (labelSpan) labelSpan.textContent = cfg.label;
  }

  const idMap = {
    '.current-button': `current${cap}FileButton`,
    '.single-empty-button': `empty${cap}FileButton`,
    '.multiple-toggle': `toggle${cap}Files`,
    '.add-opened-button': `addOpened${cap}FilesButton`,
    '.multi-empty-button': `empty${cap}FilesButton`,
    '.select-multiple-button': `select${cap}FilesButton`,
    select: `${type}File`,
    '.multiple-files-container': `${type}FilesContainer`,
    '.multiple-files-list': `${type}Files`,
  };

  Object.entries(idMap).forEach(([selector, id]) => {
    const el = element.querySelector(selector);
    if (el) el.id = id;
  });

  const toggle = element.querySelector('.multiple-toggle');
  if (toggle) toggle.dataset.filetype = type;
  const multiEmpty = element.querySelector('.multi-empty-button');
  if (multiEmpty) multiEmpty.dataset.filetype = type;
  const addOpened = element.querySelector('.add-opened-button');
  if (addOpened) addOpened.title = `Add opened files as ${type}`;
  const currentBtn = element.querySelector('.current-button');
  if (currentBtn) currentBtn.title = `Set current file as ${type}`;

  return element;
}

export function insertFileSelectors() {
  const container = document.getElementById('fileSelectionGroup');
  const mediaTemplate = document.getElementById('mediaFileSelectorTemplate');
  if (!container) return;

  const frag = document.createDocumentFragment();
  FILE_TYPES.forEach((type) => {
    if (type === 'output') return;
    if (type === 'media') {
      if (mediaTemplate) {
        const mediaNode =
          mediaTemplate.content.firstElementChild.cloneNode(true);
        frag.appendChild(mediaNode);
      }
      return;
    }
    const selector = createFileSelector(type);
    if (selector) frag.appendChild(selector);
  });
  container.prepend(frag);
}
