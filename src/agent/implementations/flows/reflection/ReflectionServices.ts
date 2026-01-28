import type { IOutputHandler } from '@agent/output/IOutputHandler';
import type { AgentWorkflowSetting } from '@agent/core/AgentDataclass';
import type { RoundFinalizedCallback } from '@agent/core/flows/CycleServices';
import type { AgentLogStage } from '@logger/AgentLogger';
import type { PromptBuilder } from '@utils/prompt';
import type {
  AgentFileLocation,
  TaskRunFileService,
  WorkspaceFileLocation,
} from '@utils/files';
import type { LatexMediaManager } from '@latex';
import type {
  BaseFlowContextInit,
  FlowParams,
} from '../common/BaseFlowServices';

export interface ReflectionServices<C = unknown> extends BaseFlowContextInit<C> {
  readonly setting: AgentWorkflowSetting;
  readonly outputHandler: IOutputHandler;
  readonly latexMediaManager: LatexMediaManager;
  readonly promptBuilder: PromptBuilder;
  readonly fileService: TaskRunFileService;
  readonly parentStage: AgentLogStage;
  readonly getOutputFileLocation: (round: number) => AgentFileLocation;
  readonly shouldEnsureXmlStructure: boolean;
  readonly baseFiles: WorkspaceFileLocation[];
  readonly getUsageRecorder: () => RoundFinalizedCallback;
}

export type { FlowParams as ReflectionFlowParams };
