import * as vscode from 'vscode';
import { getConfig } from '../utils/commonUtils';
import { debug } from '../logger/logUtils';

const CHANNEL = 'MergeCommands';

export function registerMergeCommands(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand('coauthor.merge', handleMerge),
  );
}

async function handleMerge(
  inputFile: string,
  baseFile: string,
  editedFile: string,
) {
  const model = getConfig('merge.defaultModel', 'sonnet+');
  const terminalName = `Merge@${model}`;
  const terminal_new = vscode.window.createTerminal(terminalName);
  terminal_new.show();

  if (editedFile && (baseFile || inputFile)) {
    const fileToUse = baseFile || inputFile;
    terminal_new.sendText(
      `coauthor merge --input_file="${fileToUse}" --edited_file="${editedFile}" --model=${model}`,
    );
  } else {
    vscode.window.showErrorMessage(
      'Both input file and edited file must be specified for merge operation',
    );
  }
}

export const mergeCommands = {
  handleMerge,
};
