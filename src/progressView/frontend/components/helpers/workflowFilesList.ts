// Third-party imports
import { html, nothing, type TemplateResult } from 'lit';
import { repeat } from 'lit/directives/repeat.js';

// Local imports - shared utilities
import { getBasename } from '@shared/utils/path';

// Local imports - shared schemas
import type { WorkflowAgentProposalPermission } from '@shared/schemas';

export interface WorkflowFileList {
  label: string;
  files: string[];
}

export function buildWorkflowFileLists(
  proposal: WorkflowAgentProposalPermission,
): WorkflowFileList[] {
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
  fileLists: WorkflowFileList[],
  options: {
    listClassName: (label: string) => string;
    labelClassName: string;
    fileClassName: string;
    onFileClick?: (file: string) => void;
  },
): TemplateResult {
  return html`${repeat(
    fileLists,
    ({ label }) => label,
    ({ label, files }) => renderWorkflowFileList(label, files, options),
  )}`;
}

function renderWorkflowFileList(
  label: string,
  files: string[],
  options: {
    listClassName: (label: string) => string;
    labelClassName: string;
    fileClassName: string;
    onFileClick?: (file: string) => void;
  },
): TemplateResult | typeof nothing {
  if (files.length === 0) return nothing;

  return html`
    <div class=${options.listClassName(label)}>
      <span class=${options.labelClassName}>${label}:</span>
      ${repeat(
        files,
        (file, index) => `${label}-${index}-${file}`,
        (file, index) =>
          html`${index > 0 ? ', ' : ''}<span
              class=${options.fileClassName}
              title=${file}
              @click=${() => options.onFileClick?.(file)}
              >${getBasename(file)}</span
            >`,
      )}
    </div>
  `;
}
