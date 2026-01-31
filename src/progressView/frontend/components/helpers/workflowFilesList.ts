// Third-party imports
import { html, nothing, type TemplateResult } from 'lit';
import { repeat } from 'lit/directives/repeat.js';

// Local imports - shared utilities
import { getBasename } from '@shared/utils/path';

// Local imports - shared schemas
import type { WorkflowAgentProposalPermission } from '@shared/schemas';

export interface WorkflowFileListEntry {
  label: string;
  files: string[];
}

export interface WorkflowFilesRenderOptions {
  getContainerClass: (label: string) => string;
  labelClass: string;
  fileClass: string;
  onFileClick?: (file: string) => void;
}

export function buildWorkflowFileLists(
  proposal: WorkflowAgentProposalPermission,
): WorkflowFileListEntry[] {
  const combine = (single: string | null | undefined, arr: string[] = []) =>
    [single, ...arr].filter((f): f is string => Boolean(f));

  return [
    { label: 'Input', files: combine(proposal.inputFile, proposal.inputFiles) },
    {
      label: 'Reference',
      files: combine(proposal.referenceFile, proposal.referenceFiles),
    },
    {
      label: 'Auxiliary',
      files: combine(proposal.auxiliaryFile, proposal.auxiliaryFiles),
    },
    { label: 'Media', files: combine(proposal.mediaFile, proposal.mediaFiles) },
    { label: 'Output', files: proposal.outputFiles ?? [] },
  ];
}

export function renderWorkflowFilesList(
  fileLists: WorkflowFileListEntry[],
  options: WorkflowFilesRenderOptions,
): TemplateResult {
  return html`${repeat(
    fileLists,
    ({ label }) => label,
    ({ label, files }) => {
      if (files.length === 0) return nothing;
      return html`
        <div class=${options.getContainerClass(label)}>
          <span class=${options.labelClass}>${label}:</span>
          ${repeat(
            files,
            (file) => file,
            (file, index) =>
              html`${index > 0 ? ', ' : ''}<span
                  class=${options.fileClass}
                  title=${file}
                  @click=${() => options.onFileClick?.(file)}
                  >${getBasename(file)}</span
                >`,
          )}
        </div>
      `;
    },
  )}`;
}
