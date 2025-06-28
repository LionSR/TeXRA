// Local imports
import {
  CHEVRON_DOWN_CLASS,
  CHEVRON_RIGHT_CLASS,
} from '@common/webviewContext.js';

/**
 * Manages rendering of required file and figure status.
 */
export class InputStatus {
  update(status) {
    const container = document.getElementById('inputStatus');
    if (!container) return;
    container.innerHTML = '';
    if (!status) return;

    if (status.required && status.required.length > 0) {
      container.appendChild(this._createFileSection(status.required));
    }
    if (status.figures && status.figures.length > 0) {
      container.appendChild(this._createFigureSection(status.figures));
    }
  }

  _createFileSection(items) {
    const found = items.filter((i) => i.found);
    const missing = items.filter((i) => !i.found);
    const details = document.createElement('details');
    details.className = 'special-details';
    details.open = true;
    details.innerHTML = `<summary><i class="${CHEVRON_DOWN_CLASS} toggle-icon"></i><i class="codicon codicon-file-directory"></i><span>Loading Files \u2705${found.length} ${missing.length ? `\u26A0\uFE0F${missing.length} missing` : ''}</span></summary>`;
    const content = document.createElement('div');
    content.className = 'special-content';
    if (missing.length > 0) {
      content.appendChild(this._createList('Missing', missing));
    }
    if (found.length > 0) {
      content.appendChild(this._createList('Found', found, false));
    }
    details.appendChild(content);
    return details;
  }

  _createFigureSection(figures) {
    const details = document.createElement('details');
    details.className = 'special-details';
    details.open = true;
    details.innerHTML = `<summary><i class="${CHEVRON_DOWN_CLASS} toggle-icon"></i><i class="codicon codicon-file-media"></i><span>Loading Figures (${figures.length})</span></summary>`;
    const content = document.createElement('div');
    content.className = 'special-content';
    figures.forEach((f) => {
      const el = document.createElement('div');
      el.textContent = f.path;
      el.className = 'input-status-file clickable-link';
      el.dataset.file = f.path;
      content.appendChild(el);
    });
    details.appendChild(content);
    return details;
  }

  _createList(label, items, open = true) {
    const d = document.createElement('details');
    d.className = 'special-details';
    d.open = open;
    d.innerHTML = `<summary><i class="${open ? CHEVRON_DOWN_CLASS : CHEVRON_RIGHT_CLASS} toggle-icon"></i><span>${label} (${items.length})</span></summary>`;
    const c = document.createElement('div');
    c.className = 'special-content';
    items.forEach((it) => {
      const el = document.createElement('div');
      el.textContent = it.path;
      el.className = 'input-status-file clickable-link';
      el.dataset.file = it.path;
      c.appendChild(el);
    });
    d.appendChild(c);
    return d;
  }
}
