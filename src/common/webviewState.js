const vscode = acquireVsCodeApi();

export function getWebviewState() {
  try {
    return vscode.getState() || {};
  } catch (e) {
    console.error('Failed to get state:', e);
    return {};
  }
}

export function setWebviewState(state) {
  try {
    vscode.setState(state);
  } catch (e) {
    console.error('Failed to set state:', e);
  }
}

export function updateWebviewState(partial) {
  const current = getWebviewState();
  setWebviewState({ ...current, ...partial });
}
