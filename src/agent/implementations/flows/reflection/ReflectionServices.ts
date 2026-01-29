/**
 * Service interfaces for reflection (workflow) flow.
 *
 * Extends BaseFlowContextInit with:
 * - Narrowed setting type (AgentWorkflowSetting)
 * - Required getUsageRecorder (narrowed from optional)
 * - Workflow-specific services (outputState, promptBuilder, etc.)
 */

import type { AgentWorkflowSetting } from '@agent/core/AgentDataclass';
import type { RoundFinalizedCallback } from '@agent/core/flows/CycleServices';
import type { OutputState, OutputDependencies } from '@agent/output/outputState';
import type { LatexDiffManager } from '@agent/output/LatexDiffManager';
import type { XmlOutputManager } from '@agent/output/XmlOutputManager';
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

/** Services for reflection flow nodes. Extends BaseFlowContextInit with workflow-specific dependencies. */
export interface ReflectionServices<
  C = unknown,
> extends BaseFlowContextInit<C> {
  /** Narrowed from AgentSetting to workflow-specific type */
  readonly setting: AgentWorkflowSetting;
  /** Mutable state for output processing */
  readonly outputState: OutputState;
  /** Dependencies for output utility functions */
  readonly outputDeps: OutputDependencies;
  /** Manager for XML output processing */
  readonly xmlManager: XmlOutputManager;
  /** Manager for latexdiff operations */
  readonly diffManager: LatexDiffManager;
  readonly latexMediaManager: LatexMediaManager;
  readonly promptBuilder: PromptBuilder;
  readonly fileService: TaskRunFileService;
  readonly getOutputFileLocation: (round: number) => AgentFileLocation;
  readonly shouldEnsureXmlStructure: boolean;
  readonly baseFiles: WorkspaceFileLocation[];
  /** Narrowed from optional to required for workflow flows */
  readonly getUsageRecorder: () => RoundFinalizedCallback;
}

export type { FlowParams as ReflectionFlowParams };
