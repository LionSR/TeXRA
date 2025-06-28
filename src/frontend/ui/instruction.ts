// Third-party imports
import * as vscode from 'vscode';

// Standard library imports
import * as path from 'path';

// Local imports
import { WorkspaceFS, AbsoluteFS } from '@utils/files';
import { INSTRUCTION_PREFIX, globalSM } from '@utils/stateManager';
import { emitProgress } from '@eventBus/ProgressEventBus';

/**
 * Show an instruction message that can be permanently dismissed.
 *
 * @param key Unique key for the instruction
 * @param message Message to display to the user
 */
export async function showInstructionWithSuppress(
  key: string,
  message: string,
  actions?: { title: string; callback: () => Thenable<void> | void }[],
  showSuppress = true,
): Promise<void> {
  if (showSuppress) {
    const dismissed = globalSM.get<boolean>(`${INSTRUCTION_PREFIX}${key}`);
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
    await globalSM.update(`${INSTRUCTION_PREFIX}${key}`, true);
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
  streamId?: string,
): Promise<void> {
  if (!expectedFiles || expectedFiles.length === 0) {
    return;
  }

  for (const [idx, file] of expectedFiles.entries()) {
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
      if (streamId && xmlPath) {
        const match = /_r(\d+)/.exec(file) || /_r(\d+)/.exec(xmlPath);
        const round = match ? parseInt(match[1], 10) : idx;
        emitProgress('addMissingOutput', {
          stream: streamId,
          round,
          xmlPath,
        });
      }
      break;
    }
  }
}
