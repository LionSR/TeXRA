import { vscode } from '@common/webviewContext.js';
import { capitalize } from '@common/stringUtils.js';

export function handleCheckboxChange(event) {
  const checkbox = event?.target || this;
  const checkboxId = checkbox.id;
  const isChecked = checkbox.checked;

  vscode.postMessage({
    command: `update${capitalize(checkboxId)}`,
    value: isChecked,
  });
}
