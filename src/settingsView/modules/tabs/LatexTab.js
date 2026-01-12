/**
 * LaTeX Tab
 */
import { vscode } from '@common/webviewContext.js';
import { settingsViewState } from '../settingsViewState.js';
import { SETTINGS_VIEW_COMMANDS, REPLACEMENT_CATEGORIES, REGEX_REPLACEMENTS } from '../constants.js';

export class LatexTab {
  constructor() {
    this._elements = null;
  }

  initialize() {
    this._elements = {
      // Formatter
      formatterSelect: document.getElementById('formatterSelect'),
      latexindentConfigRow: document.getElementById('latexindentConfigRow'),
      latexindentConfig: document.getElementById('latexindentConfig'),
      browseLatexindentConfig: document.getElementById('browseLatexindentConfig'),
      texfmtConfigRow: document.getElementById('texfmtConfigRow'),
      texfmtConfig: document.getElementById('texfmtConfig'),
      browseTexfmtConfig: document.getElementById('browseTexfmtConfig'),
      showLatexindentWarning: document.getElementById('showLatexindentWarning'),

      // LaTeXdiff
      latexdiffTimeout: document.getElementById('latexdiffTimeout'),
      mathMarkupSelect: document.getElementById('mathMarkupSelect'),
      pictureEnvironments: document.getElementById('pictureEnvironments'),
      generateBetweenRoundDiffs: document.getElementById('generateBetweenRoundDiffs'),

      // TikZ
      tikzInputDirectory: document.getElementById('tikzInputDirectory'),
      browseTikzInputDirectory: document.getElementById('browseTikzInputDirectory'),
      includeWorkspaceInTexinputs: document.getElementById('includeWorkspaceInTexinputs'),
      tikzTemplate: document.getElementById('tikzTemplate'),

      // Replacements
      wrapCritiqueInAlign: document.getElementById('wrapCritiqueInAlign'),
      replacementCategories: document.getElementById('replacementCategories'),
      regexReplacements: document.getElementById('regexReplacements'),
    };

    this.attachEventListeners();
  }

  attachEventListeners() {
    const {
      formatterSelect,
      latexindentConfig,
      browseLatexindentConfig,
      texfmtConfig,
      browseTexfmtConfig,
      showLatexindentWarning,
      latexdiffTimeout,
      mathMarkupSelect,
      pictureEnvironments,
      generateBetweenRoundDiffs,
      tikzInputDirectory,
      browseTikzInputDirectory,
      includeWorkspaceInTexinputs,
      tikzTemplate,
      wrapCritiqueInAlign,
    } = this._elements;

    // Formatter select
    if (formatterSelect) {
      formatterSelect.addEventListener('change', () => {
        this.updateFormatterVisibility();
        this.saveSetting('latex.formatter', formatterSelect.value);
      });
    }

    // Config file inputs
    if (latexindentConfig) {
      latexindentConfig.addEventListener('change', () => {
        this.saveSetting('latex.latexindentConfig', latexindentConfig.value);
      });
    }

    if (texfmtConfig) {
      texfmtConfig.addEventListener('change', () => {
        this.saveSetting('latex.texfmtConfig', texfmtConfig.value);
      });
    }

    // Browse buttons
    if (browseLatexindentConfig) {
      browseLatexindentConfig.addEventListener('click', () => {
        this.browseFile('latex.latexindentConfig', 'Select latexindent config file', {
          'YAML': ['yaml', 'yml'],
        });
      });
    }

    if (browseTexfmtConfig) {
      browseTexfmtConfig.addEventListener('click', () => {
        this.browseFile('latex.texfmtConfig', 'Select tex-fmt config file', {
          'TOML': ['toml'],
        });
      });
    }

    if (browseTikzInputDirectory) {
      browseTikzInputDirectory.addEventListener('click', () => {
        this.browseFile('latex.tikzInputDirectory', 'Select TikZ input directory');
      });
    }

    // Checkboxes
    if (showLatexindentWarning) {
      showLatexindentWarning.addEventListener('change', () => {
        this.saveSetting('latex.showLatexindentWarning', showLatexindentWarning.checked);
      });
    }

    if (generateBetweenRoundDiffs) {
      generateBetweenRoundDiffs.addEventListener('change', () => {
        this.saveSetting('latexdiff.generateBetweenRoundDiffs', generateBetweenRoundDiffs.checked);
      });
    }

    if (includeWorkspaceInTexinputs) {
      includeWorkspaceInTexinputs.addEventListener('change', () => {
        this.saveSetting('latex.includeWorkspaceInTexinputs', includeWorkspaceInTexinputs.checked);
      });
    }

    if (wrapCritiqueInAlign) {
      wrapCritiqueInAlign.addEventListener('change', () => {
        this.saveSetting('latex.wrapCritiqueInAlign', wrapCritiqueInAlign.checked);
      });
    }

    // LaTeXdiff settings
    if (latexdiffTimeout) {
      latexdiffTimeout.addEventListener('change', () => {
        this.saveSetting('latexdiff.timeoutMs', parseInt(latexdiffTimeout.value, 10));
      });
    }

    if (mathMarkupSelect) {
      mathMarkupSelect.addEventListener('change', () => {
        this.saveSetting('latexdiff.mathMarkup', mathMarkupSelect.value);
      });
    }

    if (pictureEnvironments) {
      pictureEnvironments.addEventListener('change', () => {
        this.saveSetting('latexdiff.pictureEnvironments', pictureEnvironments.value);
      });
    }

    // TikZ settings
    if (tikzInputDirectory) {
      tikzInputDirectory.addEventListener('change', () => {
        this.saveSetting('latex.tikzInputDirectory', tikzInputDirectory.value);
      });
    }

    if (tikzTemplate) {
      tikzTemplate.addEventListener('change', () => {
        this.saveSetting('latex.tikzTemplate', tikzTemplate.value);
      });
    }

    // Replacement checkboxes (event delegation - listeners set once, not per-render)
    const { replacementCategories, regexReplacements } = this._elements;

    if (replacementCategories) {
      replacementCategories.addEventListener('change', (e) => {
        const checkbox = e.target.closest('vscode-checkbox');
        if (checkbox && checkbox.dataset.category) {
          this.handleReplacementCategoryChange(checkbox.dataset.category, checkbox.checked);
        }
      });
    }

    if (regexReplacements) {
      regexReplacements.addEventListener('change', (e) => {
        const checkbox = e.target.closest('vscode-checkbox');
        if (checkbox && checkbox.dataset.regex) {
          this.handleRegexReplacementChange(checkbox.dataset.regex, checkbox.checked);
        }
      });
    }
  }

  saveSetting(key, value) {
    vscode.postMessage({
      command: SETTINGS_VIEW_COMMANDS.SAVE_SETTING,
      key: `texra.${key}`,
      value,
      target: 'workspace',
    });

    settingsViewState.setLatexSetting(key, value);
  }

  browseFile(settingKey, dialogTitle, filters = {}) {
    vscode.postMessage({
      command: SETTINGS_VIEW_COMMANDS.BROWSE_FILE,
      settingKey: `texra.${settingKey}`,
      dialogTitle,
      filters,
    });
  }

  updateFormatterVisibility() {
    const { formatterSelect, latexindentConfigRow, texfmtConfigRow } = this._elements;
    if (!formatterSelect) return;

    const formatter = formatterSelect.value;

    if (latexindentConfigRow) {
      latexindentConfigRow.style.display = formatter === 'latexindent' ? 'flex' : 'none';
    }

    if (texfmtConfigRow) {
      texfmtConfigRow.style.display = formatter === 'tex-fmt' ? 'flex' : 'none';
    }
  }

  render(state) {
    const settings = state.latexSettings;

    // Formatter
    this.setValue('formatterSelect', settings.formatter);
    this.setValue('latexindentConfig', settings.latexindentConfig);
    this.setValue('texfmtConfig', settings.texfmtConfig);
    this.setChecked('showLatexindentWarning', settings.showLatexindentWarning);
    this.updateFormatterVisibility();

    // LaTeXdiff
    this.setValue('latexdiffTimeout', settings.latexdiffTimeoutMs);
    this.setValue('mathMarkupSelect', settings.latexdiffMathMarkup);
    this.setValue('pictureEnvironments', settings.latexdiffPictureEnvironments);
    this.setChecked('generateBetweenRoundDiffs', settings.latexdiffGenerateBetweenRoundDiffs);

    // TikZ
    this.setValue('tikzInputDirectory', settings.tikzInputDirectory);
    this.setChecked('includeWorkspaceInTexinputs', settings.includeWorkspaceInTexinputs);
    this.setValue('tikzTemplate', settings.tikzTemplate);

    // Replacements
    this.setChecked('wrapCritiqueInAlign', settings.wrapCritiqueInAlign);
    this.renderReplacementCheckboxes(settings);
  }

  setValue(id, value) {
    const element = this._elements[id];
    if (element && value !== undefined) {
      element.value = value;
    }
  }

  setChecked(id, value) {
    const element = this._elements[id];
    if (element) {
      element.checked = value !== false;
    }
  }

  renderReplacementCheckboxes(settings) {
    const { replacementCategories, regexReplacements } = this._elements;

    // Render replacement categories
    if (replacementCategories) {
      const enabledCategories = new Set(settings.enabledReplacements || []);
      replacementCategories.innerHTML = REPLACEMENT_CATEGORIES.map((cat) => `
        <vscode-checkbox
          data-category="${cat}"
          ${enabledCategories.has(cat) ? 'checked' : ''}
        >
          ${cat.replace(/_/g, ' ')}
        </vscode-checkbox>
      `).join('');
    }

    // Render regex replacements
    if (regexReplacements) {
      const enabledRegex = new Set(settings.enabledReplacementsRegex || []);
      regexReplacements.innerHTML = REGEX_REPLACEMENTS.map((regex) => `
        <vscode-checkbox
          data-regex="${regex}"
          ${enabledRegex.has(regex) ? 'checked' : ''}
        >
          ${regex.replace(/_/g, ' ')}
        </vscode-checkbox>
      `).join('');
    }
  }

  handleReplacementCategoryChange(category, enabled) {
    const current = new Set(settingsViewState.latexSettings.enabledReplacements || []);
    if (enabled) {
      current.add(category);
    } else {
      current.delete(category);
    }
    this.saveSetting('latex.enabledReplacements', [...current]);
  }

  handleRegexReplacementChange(regex, enabled) {
    const current = new Set(settingsViewState.latexSettings.enabledReplacementsRegex || []);
    if (enabled) {
      current.add(regex);
    } else {
      current.delete(regex);
    }
    this.saveSetting('latex.enabledReplacementsRegex', [...current]);
  }
}
