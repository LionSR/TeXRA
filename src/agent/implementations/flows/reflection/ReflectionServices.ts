import type { PromptBuilder } from '@agent/prompt/PromptBuilder';
import type { AgentWorkflowSetting } from '@agent/core/definition/AgentDataclass';
import type { BaseFlowContextInit } from '@agent/core/flows/BaseFlowServices';
import type { LatexMediaManager } from '@latex/LatexMediaManager';
import type { AgentFileLocation, FileLocation } from '@shared/schemas';
import type { TaskRunFileService } from '@utils/files/taskRunStorage';
import type { OutputState } from './output/outputState';
import type { LatexDiffManager } from './output/LatexDiffManager';
import type { XmlOutputManager } from './output/XmlOutputManager';

export interface WorkflowOutputPolicy {
  readonly shouldAutoOpenPdfOrLog: () => boolean;
  readonly shouldRejectOnCompileFailure: () => boolean;
}

export interface ReflectionServices<
  C = unknown,
> extends BaseFlowContextInit<C> {
  readonly setting: AgentWorkflowSetting;
  readonly outputState: OutputState;
  readonly xmlManager: XmlOutputManager;
  readonly diffManager: LatexDiffManager;
  readonly latexMediaManager: LatexMediaManager;
  readonly promptBuilder: PromptBuilder;
  readonly fileService: TaskRunFileService;
  readonly getOutputFileLocation: (
    round: number,
  ) => AgentFileLocation | Promise<AgentFileLocation>;
  readonly workflowOutputPolicy: WorkflowOutputPolicy;
  readonly baseFiles: FileLocation[];
}
