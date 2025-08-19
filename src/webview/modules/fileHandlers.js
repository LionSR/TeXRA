// Local imports - webview
import { mainViewState } from './mainViewState.js';

export function handleCheckboxChange(event) {
  const checkbox = event?.target || this;
  const checkboxId = checkbox.id;
  const isChecked = checkbox.checked;

  mainViewState.update({ [checkboxId]: isChecked });
  mainViewState.save();
}
