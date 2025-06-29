// Local imports
import { vscode } from '@common/webviewContext.js';

/**
 * Manages display of output check results.
 */
export class OutputStatus {
  update(checksByRound) {
    const container = document.getElementById('outputStatus');
    if (!container) return;

    container.innerHTML = '';
    if (!checksByRound || Object.keys(checksByRound).length === 0) {
      return;
    }

    const rounds = Object.keys(checksByRound)
      .map((r) => parseInt(r, 10))
      .sort((a, b) => a - b);

    rounds.forEach((round) => {
      const items = checksByRound[round];
      if (!Array.isArray(items) || items.length === 0) return;

      const group = document.createElement('div');
      group.className = 'output-status-group';

      const header = document.createElement('div');
      header.className = 'output-status-header';
      header.textContent = `r${round}`;
      group.appendChild(header);

      const list = document.createElement('ul');
      list.className = 'output-status-list';

      items.forEach((it) => {
        if (!it || !it.file) return;
        const li = document.createElement('li');
        const fileName = it.file.split('/').pop() || it.file;
        li.innerHTML = `<i class="codicon codicon-warning"></i> ${this._escapeHtml(
          fileName,
        )}`;
        if (it.xml) {
          const link = document.createElement('span');
          link.textContent = 'Open XML';
          link.className = 'xml-link clickable-link';
          link.dataset.file = it.xml;
          li.appendChild(document.createTextNode(' '));
          li.appendChild(link);
        }
        list.appendChild(li);
      });

      group.appendChild(list);
      container.appendChild(group);
    });
  }

  _escapeHtml(text) {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
}
