export class InputStatus {
  update(status) {
    const container = document.getElementById('inputStatus');
    if (!container) return;
    container.innerHTML = '';
    if (!status) return;

    const required = Array.isArray(status.required) ? status.required : [];
    const figures = Array.isArray(status.figures) ? status.figures : [];

    const found = required.filter((r) => r.found);
    const missing = required.filter((r) => !r.found);

    const summary = document.createElement('div');
    summary.className = 'input-summary';
    summary.innerHTML = `
      <span class="input-label"><i class="codicon codicon-folder"></i> File Loading Status</span>
      <span class="input-counts">
        <span class="success-count">${found.length} found</span>
        <span class="missing-count">${missing.length} missing</span>
      </span>`;
    container.appendChild(summary);

    if (missing.length > 0) {
      const det = document.createElement('details');
      det.className = 'special-details';
      det.open = true;
      det.innerHTML = `
        <summary><i class="codicon codicon-chevron-down toggle-icon"></i> Missing Files (${missing.length})</summary>
        <ul class="special-content file-status-list"></ul>`;
      const list = det.querySelector('ul');
      missing.forEach((m) => {
        const li = document.createElement('li');
        li.textContent = `${m.path} (${m.varName})`;
        list.appendChild(li);
      });
      container.appendChild(det);
    }

    if (found.length > 0) {
      const det = document.createElement('details');
      det.className = 'special-details';
      det.innerHTML = `
        <summary><i class="codicon codicon-chevron-right toggle-icon"></i> Found Files (${found.length})</summary>
        <ul class="special-content file-status-list"></ul>`;
      const list = det.querySelector('ul');
      found.forEach((f) => {
        const li = document.createElement('li');
        li.textContent = `${f.path} (${f.varName})`;
        list.appendChild(li);
      });
      container.appendChild(det);
    }

    if (figures.length > 0) {
      const det = document.createElement('details');
      det.className = 'special-details';
      det.innerHTML = `
        <summary><i class="codicon codicon-chevron-right toggle-icon"></i> Added Figures (${figures.length})</summary>
        <div class="special-content figure-list"></div>`;
      const div = det.querySelector('.figure-list');
      div.textContent = figures.join(', ');
      container.appendChild(det);
    }
  }
}
