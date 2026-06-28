import {
  computeRuntimeAgentOptionsData,
  type RuntimeAgentOptionsData,
} from '@agent/runtime/agentResolution';
import { toErrorMessage } from '@common/errors';
import { createChannelTrace } from '@logger';
import {
  buildVisibleBasicModelOptionsData,
  computeModelOptionsData,
} from '@model/computeModelOptions';
import type {
  AgentOptionData,
  AgentProposalPermission,
  ModelOptionData,
} from '@shared/schemas';
import { AgentCategory, agentName } from '@shared/schemas/agent';

const logger = createChannelTrace('ProgressProposalOptionsController');

export interface ProgressProposalOptionsData {
  readonly modelOptionsData: ModelOptionData[];
  readonly agentOptionsData?: AgentOptionData[];
}

export interface ProgressProposalOptionsControllerDeps {
  readonly loadModelOptions?: () => Promise<ModelOptionData[]>;
  readonly loadAgentOptions?: () => Promise<RuntimeAgentOptionsData>;
  readonly buildFallbackModelOptions?: () => ModelOptionData[];
}

/**
 * Builds dropdown data for progress-view agent proposal requests.
 *
 * Proposal permissions store the proposed agent as a plain name. Runtime agent
 * option rows use source-qualified values. This controller keeps those
 * identities separate while preserving labels and metadata for rendering.
 */
export class ProgressProposalOptionsController {
  constructor(
    private readonly deps: ProgressProposalOptionsControllerDeps = {},
  ) {}

  getInitialOptions(): Pick<ProgressProposalOptionsData, 'modelOptionsData'> {
    return { modelOptionsData: this.buildFallbackModelOptions() };
  }

  async buildOptions(
    proposal: AgentProposalPermission,
  ): Promise<ProgressProposalOptionsData> {
    const [modelOptionsData, agentOptionsData] = await Promise.all([
      this.loadModelOptionsWithFallback(),
      this.loadProposalAgentOptions(proposal).catch((error) => {
        logger.warn(
          `Failed to load proposal agent options: ${toErrorMessage(error)}`,
        );
        return undefined;
      }),
    ]);
    return { modelOptionsData, agentOptionsData };
  }

  private async loadModelOptionsWithFallback(): Promise<ModelOptionData[]> {
    try {
      return await (this.deps.loadModelOptions ?? computeModelOptionsData)();
    } catch {
      return this.buildFallbackModelOptions();
    }
  }

  private async loadProposalAgentOptions(
    proposal: AgentProposalPermission,
  ): Promise<AgentOptionData[]> {
    const all = await (
      this.deps.loadAgentOptions ?? computeRuntimeAgentOptionsData
    )();
    const raw =
      proposal.agentCategory === AgentCategory.Workflow
        ? (all.workflow ?? [])
        : (all.toolUse ?? []);
    return raw.map((option) => ({
      ...option,
      value: agentName(option.value),
    }));
  }

  private buildFallbackModelOptions(): ModelOptionData[] {
    return (
      this.deps.buildFallbackModelOptions ?? buildVisibleBasicModelOptionsData
    )();
  }
}
