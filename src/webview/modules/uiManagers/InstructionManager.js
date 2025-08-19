// Local imports - webview
import { setupPasteListener } from '../pasteHandler.js';
import { safeGetElementById } from '@common/domUtils.js';

export class InstructionManager {
  constructor(textareaId, vscode, state) {
    this.textareaId = textareaId;
    this.vscode = vscode;
    this.state = state;
  }

  autoResizeTextarea(textarea) {
    textarea.style.height = 'auto';
    const maxHeight = 400;
    const newHeight = Math.min(textarea.scrollHeight, maxHeight);
    textarea.style.height = `${newHeight}px`;
    textarea.style.overflowY =
      textarea.scrollHeight > maxHeight ? 'auto' : 'hidden';
  }

  insertTextAtCursor(textarea, text) {
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const original = textarea.value;
    textarea.value = original.slice(0, start) + text + original.slice(end);
    textarea.selectionStart = textarea.selectionEnd = start + text.length;
  }

  setup() {
    const textarea = safeGetElementById(this.textareaId);
    if (!textarea) {
      console.warn(
        `[InstructionManager] Element with id '${this.textareaId}' not found`,
      );
      return;
    }

    this.autoResizeTextarea(textarea);

    textarea.addEventListener('input', () => {
      this.autoResizeTextarea(textarea);
      this.state?.save();
    });

    setupPasteListener(
      textarea,
      this.vscode,
      (ta) => this.autoResizeTextarea(ta),
      () => this.state?.save(),
      (ta, text) => this.insertTextAtCursor(ta, text),
    );
  }
}
