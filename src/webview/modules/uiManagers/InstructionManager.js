// Local imports - webview
import { setupPasteListener } from '../pasteHandler.js';
import { safeGetElementById } from '@common/domUtils.js';
import {
  autoResizeTextarea as resizeTextarea,
  insertTextAtCursor as insertAtCursor,
} from '@common/modules/textareaUtils.js';

export class InstructionManager {
  constructor(textareaId, vscode, state) {
    this.textareaId = textareaId;
    this.vscode = vscode;
    this.state = state;
  }

  autoResizeTextarea(textarea) {
    resizeTextarea(textarea);
  }

  insertTextAtCursor(textarea, text) {
    insertAtCursor(textarea, text);
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
