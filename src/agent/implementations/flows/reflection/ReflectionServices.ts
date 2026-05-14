import type { AgentWorkflowSetting } from '@agent/core/AgentDataclass';
import type { RoundFinalizedCallback } from '@agent/core/flows/CycleServices';
import type { OutputState } from '@agent/output/outputState';
import type { LatexDiffManager } from '@agent/output/LatexDiffManager';
import type { XmlOutputManager } from '@agent/output/XmlOutputManager';
import type { LatexMediaManager } from '@latex';
import type { PromptBuilder } from '@utils/prompt';
import type {
  AgentFileLocation,
  TaskRunFileService,
  WorkspaceFileLocation,
} from '@utils/files';
import type {
  BaseFlowContextInit,
  FlowParams,
} from '../common/BaseFlowServices';

export interface ReflectionServices<C = unknown>
  extends BaseFlowContextInit<C> {
  readonly setting: AgentWorkflowSetting;
  readonly outputState: OutputState;
  readonly xmlManager: XmlOutputManager;
  readonly diffManager: LatexDiffManager;
  readonly latexMediaManager: LatexMediaManager;
  readonly promptBuilder: PromptBuilder;
  readonly fileService: TaskRunFileService;
  readonly getOutputFileLocation: (round: number) => AgentFileLocation;
  readonly baseFiles: WorkspaceFileLocation[];
  readonly onRoundFinalized: RoundFinalizedCallback;
}

export type { FlowParams as ReflectionFlowParams };
