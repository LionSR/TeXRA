// Local imports - webview
import { setupPasteListener } from '../pasteHandler.js';
import {
  ELEMENT_IDS,
  parseSessionType,
  resolveRadioGroup,
  SESSION_TYPE_INPUT,
  SESSION_TYPES,
} from '../constants.js';

// Local imports - common
import { BaseDomHandler } from '@common/BaseDomHandler.js';
import { safeGetElementById } from '@common/domUtils.js';
import { debounce } from '@common/debounce.js';
import {
  awaitTextareaUpgrade,
  insertTextAtCursor,
  resolveTextareaTarget,
} from '@common/textareaUtils.js';

// Rotate onboarding tips slowly so users can read one example at a time.
const PLACEHOLDER_ROTATION_MS = 12000;
const ONBOARDING_PLACEHOLDERS = {
  [SESSION_TYPES.WORKFLOW]: [
    'Example: Correct LaTeX errors, tighten language, and keep math notation intact.',
    'Example: Summarize edits and list all sections you touched.',
    'Example: Explain changes in bullet points and keep the tone formal.',
  ],
  [SESSION_TYPES.TOOL_USE]: [
    'Example: Find missing citations, then suggest BibTeX entries.',
    'Example: Scan for TODOs and draft fixes with file paths.',
    'Example: Run LaTeX checks and report compilation warnings.',
  ],
};

export class InstructionManager extends BaseDomHandler {
  constructor(textareaId, vscode, state) {
    super();
    this.textareaId = textareaId;
    this.vscode = vscode;
    this.state = state;
    this._rotationTimer = null;
    this._rotationIndex = {
      [SESSION_TYPES.WORKFLOW]: 0,
      [SESSION_TYPES.TOOL_USE]: 0,
    };
    this._textarea = null;
  }

  /**
   * Set up the instruction textarea with debounced saves, paste handling,
   * and placeholder rotation.
   *
   * Note: This must be called after mainViewState.restore() so that any
   * restored textarea value is present when placeholder rotation initializes.
   */
  setup() {
    const target = safeGetElementById(this.textareaId);
    if (!target) {
      console.warn(
        `[InstructionManager] Element with id '${this.textareaId}' not found`,
      );
      return;
    }

    const applySetup = () => {
      const { textarea } = resolveTextareaTarget(target);
      if (!textarea) {
        return;
      }

      // Debounce state saves to avoid saving on every keystroke
      const debouncedSave = debounce(() => this.state?.save(), 500);
      this.addListener(target, 'input', debouncedSave);

      setupPasteListener(
        target,
        this.vscode,
        () => this.state?.save(),
        (ta, text) => insertTextAtCursor(ta, text),
      );

      this._setupPlaceholderRotation(target, textarea);
    };

    awaitTextareaUpgrade(target, () => applySetup());
  }

  _setupPlaceholderRotation(target, textarea) {
    this._textarea = textarea;

    const handleInput = () => {
      if (!this._textarea) {
        return;
      }
      if (this._textarea.value.trim()) {
        this._stopRotation();
        return;
      }
      this._startRotation();
      this._refreshPlaceholder(false);
    };

    const handleSessionTypeChange = (event) => {
      if (!this._textarea) {
        return;
      }
      if (!this._textarea.value.trim()) {
        // Extract session type from event target to avoid stale hidden input value
        const sessionType = this._getSessionTypeFromEvent(event);
        if (sessionType) {
          this._refreshPlaceholderForType(sessionType);
        }
      }
    };

    // Register listeners via BaseDomHandler for automatic cleanup
    this.addListener(target, 'input', handleInput);

    // Resolve the actual radio group element, not just the container
    const toggleContainer = safeGetElementById(ELEMENT_IDS.SESSION_TYPE_TOGGLE);
    const sessionToggle = resolveRadioGroup(toggleContainer);
    if (sessionToggle) {
      this.addListener(sessionToggle, 'change', handleSessionTypeChange);
    }

    handleInput();
  }

  _startRotation() {
    if (this._rotationTimer) {
      return;
    }
    this._rotationTimer = window.setInterval(() => {
      if (!this._textarea) {
        this._stopRotation();
        return;
      }
      if (this._textarea.value.trim()) {
        this._stopRotation();
        return;
      }
      this._refreshPlaceholder(true);
    }, PLACEHOLDER_ROTATION_MS);
  }

  _stopRotation() {
    if (this._rotationTimer) {
      window.clearInterval(this._rotationTimer);
      this._rotationTimer = null;
    }
  }

  _refreshPlaceholder(advance) {
    if (!this._textarea) {
      return;
    }
    const sessionType = this._getSessionType();
    this._refreshPlaceholderForType(sessionType, advance);
  }

  _refreshPlaceholderForType(sessionType, advance = false) {
    if (!this._textarea) {
      return;
    }
    const placeholder = this._getPlaceholder(sessionType, advance);
    if (placeholder) {
      this._textarea.placeholder = placeholder;
    }
  }

  _getPlaceholder(sessionType, advance) {
    const placeholders =
      ONBOARDING_PLACEHOLDERS[sessionType] ||
      ONBOARDING_PLACEHOLDERS[SESSION_TYPES.WORKFLOW];
    if (!placeholders.length) {
      return '';
    }
    const currentIndex = this._rotationIndex[sessionType] ?? 0;
    if (advance) {
      const nextIndex = (currentIndex + 1) % placeholders.length;
      this._rotationIndex[sessionType] = nextIndex;
      return placeholders[nextIndex];
    }
    return placeholders[currentIndex % placeholders.length];
  }

  _getSessionType() {
    const input = safeGetElementById(SESSION_TYPE_INPUT);
    if (input instanceof HTMLInputElement && input.value) {
      return parseSessionType(input.value);
    }
    return SESSION_TYPES.WORKFLOW;
  }

  _getSessionTypeFromEvent(event) {
    const target = event?.target;
    if (!(target instanceof HTMLElement)) {
      return null;
    }
    // Extract from vscode-radio element's data attribute or value
    const sessionType =
      target.dataset?.sessionType || target.getAttribute('value');
    if (sessionType) {
      return parseSessionType(sessionType);
    }
    return null;
  }

  dispose() {
    this._stopRotation();
    this._textarea = null;
    super.dispose();
  }
}
