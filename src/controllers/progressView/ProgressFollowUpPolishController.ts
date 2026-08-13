// Local imports
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import {
  polishTextWithAI,
  type FileContext,
} from '@agent/runtime/textEnhancement';
import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc';
import type { ProgressViewOutboundMessage, StreamTabId } from '@shared/schemas';
import { toErrorMessage } from '@utils/errors/errorMessage';

type UpdateFollowUpTextMessage = Extract<
  ProgressViewOutboundMessage,
  { command: typeof PROGRESS_VIEW_COMMANDS.UPDATE_FOLLOW_UP_TEXT }
>;

export interface ProgressFollowUpPolishInput {
  readonly stream: StreamTabId;
  readonly text: string;
  /** The run's config, which the command handler resolves before dispatching:
   *  a stream with no config never reaches the controller. */
  readonly runConfig: AgentConfig;
}

interface ProgressFollowUpPolishTextResult {
  readonly success: boolean;
  readonly text: string;
  readonly error?: string;
}

type ProgressFollowUpPolishText = (
  text: string,
  fileContext?: FileContext,
) => Promise<ProgressFollowUpPolishTextResult>;

export interface ProgressFollowUpPolishControllerDeps {
  readonly polishText: ProgressFollowUpPolishText;
}

export type ProgressFollowUpPolishResult =
  | { readonly kind: 'skipped' }
  | {
      readonly kind: 'updated';
      readonly update: UpdateFollowUpTextMessage;
    }
  | {
      readonly kind: 'failed';
      readonly update: UpdateFollowUpTextMessage;
      readonly userMessage: string;
    }
  | {
      readonly kind: 'exception';
      readonly update: UpdateFollowUpTextMessage;
      readonly userMessage: string;
      readonly logMessage: string;
      readonly logData?: Error;
    };

export class ProgressFollowUpPolishController {
  constructor(
    private readonly deps: ProgressFollowUpPolishControllerDeps = {
      polishText: polishTextWithAI,
    },
  ) {}

  async polishFollowUp(
    input: ProgressFollowUpPolishInput,
  ): Promise<ProgressFollowUpPolishResult> {
    try {
      const fileContext = this.buildFileContext(input.runConfig);
      const result = await this.deps.polishText(input.text, fileContext);
      if (result.success) {
        return {
          kind: 'updated',
          update: {
            command: PROGRESS_VIEW_COMMANDS.UPDATE_FOLLOW_UP_TEXT,
            stream: input.stream,
            kind: 'polished',
            text: result.text,
          },
        };
      }
      if (!result.error) {
        return { kind: 'skipped' };
      }
      return {
        kind: 'failed',
        update: this.createPolishErrorUpdate(input.stream, result.error),
        userMessage: result.error,
      };
    } catch (error) {
      const errorMsg = toErrorMessage(error);
      const logMessage = `Error polishing follow-up: ${errorMsg}`;
      return {
        kind: 'exception',
        update: this.createPolishErrorUpdate(input.stream, errorMsg),
        userMessage: logMessage,
        logMessage,
        ...(error instanceof Error && { logData: error }),
      };
    }
  }

  private buildFileContext(agentConfig: AgentConfig): FileContext {
    const context: FileContext = {};

    if (agentConfig.agent) {
      context.agent = agentConfig.agent;
    }

    const arrayFields = [
      'inputFiles',
      'contextFiles',
      'mediaFiles',
      'outputFiles',
    ] as const;
    for (const field of arrayFields) {
      if (agentConfig[field].length > 0) {
        context[field] = agentConfig[field];
      }
    }

    return context;
  }

  private createPolishErrorUpdate(
    stream: StreamTabId,
    error: string,
  ): UpdateFollowUpTextMessage {
    return {
      command: PROGRESS_VIEW_COMMANDS.UPDATE_FOLLOW_UP_TEXT,
      stream,
      kind: 'polishError',
      text: null,
      error,
    };
  }
}
