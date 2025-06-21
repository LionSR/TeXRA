import * as vscode from 'vscode';
import * as path from 'path';
import { WorkspaceFS, AbsoluteFS } from '@utils/files';

/**
 * Show an instruction message that can be permanently dismissed.
 *
 * @param context Extension context for global storage
 * @param key Unique key for the instruction
 * @param message Message to display to the user
 */
export async function showInstructionWithSuppress(
  context: vscode.ExtensionContext,
  key: string,
  message: string,
  actions?: { title: string; callback: () => Thenable<void> | void }[],
  showSuppress = true,
): Promise<void> {
  if (showSuppress) {
    const dismissed = context.globalState.get<boolean>(`instruction.${key}`);
    if (dismissed) {
      return;
    }
  }

  const never = 'Never remind again';
  const buttons = actions?.map((a) => a.title) ?? [];
  const choice = await vscode.window.showInformationMessage(
    message,
    ...buttons,
    ...(showSuppress ? [never] : []),
  );

  if (showSuppress && choice === never) {
    await context.globalState.update(`instruction.${key}`, true);
  } else if (choice) {
    const action = actions?.find((a) => a.title === choice);
    await action?.callback();
  }
}

/**
 * Validate that expected output files exist. If any are missing,
 * show a reminder about checking the XML output.
 */
export async function checkExpectedOutputs(
  expectedFiles: string[] | null | undefined,
  context: vscode.ExtensionContext,
  agent?: unknown,
): Promise<void> {
  if (!expectedFiles || expectedFiles.length === 0) {
    return;
  }

  for (const file of expectedFiles) {
    const exists = path.isAbsolute(file)
      ? await AbsoluteFS.exists(file)
      : await WorkspaceFS.exists(file);
    if (!exists) {
      const openBtn = 'Open XML';

      let xmlPath: string | undefined;
      const outputs: string[] = [];

      if (agent && typeof agent === 'object') {
        const anyAgent = agent as any;
        if (Array.isArray(anyAgent.outputFile)) {
          outputs.push(...anyAgent.outputFile.filter(Boolean));
        }
        if (anyAgent.outputHandler?.outputFiles) {
          const fileMap = anyAgent.outputHandler.outputFiles as Record<
            string,
            string[]
          >;
          for (const roundFiles of Object.values(fileMap)) {
            if (Array.isArray(roundFiles)) {
              outputs.push(...roundFiles.filter(Boolean));
            }
          }
        }
      }

      xmlPath = outputs.find((p) => p.endsWith('.xml') || p.endsWith('.tex'));
      if (!xmlPath) {
        xmlPath = file.replace(/\.[^.]+$/, '.xml');
      }

      await showInstructionWithSuppress(
        context,
        'xmlOutputMismatch',
        `Expected output "${path.basename(
          file,
        )}" was not generated. Open the XML file to check tag consistency, then run again.`,
        [
          {
            title: openBtn,
            callback: async () => {
              if (!xmlPath) {
                vscode.window.showWarningMessage('XML file path not found');
                return;
              }

              const xmlExists = path.isAbsolute(xmlPath)
                ? await AbsoluteFS.exists(xmlPath)
                : await WorkspaceFS.exists(xmlPath);
              if (!xmlExists) {
                vscode.window.showWarningMessage(
                  `XML file not found: ${path.basename(xmlPath)}`,
                );
                return;
              }
              const uri = path.isAbsolute(xmlPath)
                ? vscode.Uri.file(xmlPath)
                : vscode.Uri.file(WorkspaceFS.fullPath(xmlPath));
              const doc = await vscode.workspace.openTextDocument(uri);
              await vscode.window.showTextDocument(doc, { preview: false });
            },
          },
        ],
        false,
      );
      break;
    }
  }
}
