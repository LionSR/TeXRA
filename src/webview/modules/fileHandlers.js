import { vscode } from '@common/webviewContext.js';
import { CHECKBOX_UPDATE_COMMANDS } from './constants.js';

export function handleCheckboxChange(event) {
  const checkbox = event?.target || this;
  const checkboxId = checkbox.id;
  const isChecked = checkbox.checked;

  const command = CHECKBOX_UPDATE_COMMANDS[checkboxId];
  if (!command) {
    return;
  }

  vscode.postMessage({
    command,
    value: isChecked,
  });
}
