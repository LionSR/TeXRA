import '@vscode/codicons/dist/codicon.css';

const CODICON_STYLESHEET_ID = 'vscode-codicon-stylesheet';

if (document.getElementById(CODICON_STYLESHEET_ID) == null) {
  // @vscode-elements checks for this id before rendering icon components.
  const marker = document.createElement('style');
  marker.id = CODICON_STYLESHEET_ID;
  document.head.append(marker);
}
