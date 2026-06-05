export function formatCliRunFileInstruction(init: {
  readonly inputFiles: readonly string[];
  readonly contextFiles?: readonly string[];
}): string | undefined {
  const parts = [
    formatFileListInstruction({
      title: 'Primary user input files:',
      files: init.inputFiles,
      guidance: [
        "Treat these files as the user's task source. Read and use them before delegating work.",
        'Do not substitute unrelated workspace files for the task.',
      ],
    }),
    formatFileListInstruction({
      title: 'Read-only context files:',
      files: init.contextFiles ?? [],
      guidance: [
        'Use these files as supporting context for the task.',
        'Do not modify them unless the user explicitly asks for edits.',
      ],
    }),
  ].filter((part): part is string => part !== undefined);

  return parts.length > 0 ? parts.join('\n\n') : undefined;
}

function formatFileListInstruction(init: {
  readonly title: string;
  readonly files: readonly string[];
  readonly guidance: readonly string[];
}): string | undefined {
  if (init.files.length === 0) return undefined;
  const fileList = init.files.map((file) => `- ${JSON.stringify(file)}`);
  return [init.title, ...fileList, ...init.guidance].join('\n');
}
