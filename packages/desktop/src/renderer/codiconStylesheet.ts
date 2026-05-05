import '@vscode/codicons/dist/codicon.css';

const CODICON_STYLESHEET_ID = 'vscode-codicon-stylesheet';

if (document.getElementById(CODICON_STYLESHEET_ID) == null) {
  const marker = document.createElement('style');
  marker.id = CODICON_STYLESHEET_ID;
  document.head.append(marker);
}
