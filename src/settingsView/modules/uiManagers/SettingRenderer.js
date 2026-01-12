/**
 * Setting Renderer - Reusable setting row components
 */

/**
 * Render a dropdown setting row
 */
export function renderDropdown(id, label, options, value, description = '') {
  const optionsHtml = options
    .map(
      (opt) =>
        `<vscode-option value="${opt.value}" ${opt.value === value ? 'selected' : ''}>${opt.label}</vscode-option>`,
    )
    .join('');

  return `
    <div class="setting-row">
      <vscode-label>${label}</vscode-label>
      <vscode-single-select id="${id}" value="${value || ''}">
        ${optionsHtml}
      </vscode-single-select>
      ${description ? `<span class="setting-description">${description}</span>` : ''}
    </div>
  `;
}

/**
 * Render a checkbox setting
 */
export function renderCheckbox(id, label, checked, description = '') {
  return `
    <div class="setting-row setting-row--checkbox">
      <vscode-checkbox id="${id}" ${checked ? 'checked' : ''}>
        ${label}
      </vscode-checkbox>
      ${description ? `<span class="setting-description">${description}</span>` : ''}
    </div>
  `;
}

/**
 * Render a text input setting
 */
export function renderTextInput(
  id,
  label,
  value,
  placeholder = '',
  description = '',
) {
  return `
    <div class="setting-row">
      <vscode-label>${label}</vscode-label>
      <vscode-textfield
        id="${id}"
        value="${value || ''}"
        placeholder="${placeholder}"
      ></vscode-textfield>
      ${description ? `<span class="setting-description">${description}</span>` : ''}
    </div>
  `;
}

/**
 * Render a number input setting
 */
export function renderNumberInput(
  id,
  label,
  value,
  min,
  max,
  unit = '',
  description = '',
) {
  return `
    <div class="setting-row">
      <vscode-label>${label}</vscode-label>
      <div class="input-with-unit">
        <vscode-textfield
          id="${id}"
          type="number"
          value="${value || ''}"
          min="${min}"
          max="${max}"
        ></vscode-textfield>
        ${unit ? `<span class="unit">${unit}</span>` : ''}
      </div>
      ${description ? `<span class="setting-description">${description}</span>` : ''}
    </div>
  `;
}

/**
 * Render a file path setting with browse button
 */
export function renderFilePath(
  id,
  label,
  value,
  placeholder = '',
  browseId = '',
) {
  return `
    <div class="setting-row">
      <vscode-label>${label}</vscode-label>
      <div class="input-with-button">
        <vscode-textfield
          id="${id}"
          value="${value || ''}"
          placeholder="${placeholder}"
        ></vscode-textfield>
        <vscode-button appearance="secondary" id="${browseId || `browse${id}`}">
          Browse
        </vscode-button>
      </div>
    </div>
  `;
}

/**
 * Render a textarea setting
 */
export function renderTextarea(id, label, value, rows = 5, placeholder = '') {
  return `
    <div class="setting-row">
      <vscode-label>${label}</vscode-label>
      <vscode-textarea
        id="${id}"
        rows="${rows}"
        placeholder="${placeholder}"
      >${value || ''}</vscode-textarea>
    </div>
  `;
}

/**
 * Render a section divider
 */
export function renderDivider() {
  return '<hr class="setting-divider" />';
}

/**
 * Render a subsection label
 */
export function renderSubsectionLabel(label) {
  return `<vscode-label class="subsection-label">${label}</vscode-label>`;
}
