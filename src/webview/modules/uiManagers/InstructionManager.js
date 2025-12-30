// Local imports - webview
import { setupPasteListener } from '../pasteHandler.js';
import { safeGetElementById } from '@common/domUtils.js';
import { debounce } from '@common/debounce.js';
import {
  awaitTextareaUpgrade,
  insertTextAtCursor,
  resolveTextareaTarget,
} from '@common/textareaUtils.js';

export class InstructionManager {
  constructor(textareaId, vscode, state) {
    this.textareaId = textareaId;
    this.vscode = vscode;
    this.state = state;
  }

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
      target.addEventListener('input', debouncedSave);

      setupPasteListener(
        target,
        this.vscode,
        () => this.state?.save(),
        (ta, text) => insertTextAtCursor(ta, text),
      );
    };

    awaitTextareaUpgrade(target, () => applySetup());
  }
}
