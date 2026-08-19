// Local imports - agent
import type { AgentSetting } from '@agent/core/definition/AgentDataclass';
import type { AgentWorkspaceState } from '@agent/core/state/AgentWorkspaceState';
import type { NormalizedUsage } from '@agent/types/NormalizedUsage';
import type { MediaEntry } from '@agent/types/mediaTypes';

// Local imports - tools and utils
import type {
  CreateResponseOptions,
  CreateResponseResult,
  ExtractResponseResult,
  SdkToolCall,
} from '@agent/types/ModelHandlerContracts';
import type { ProviderStopReason } from '@agent/types/StopReasonTypes';
import type { ResponseTextProcessing } from '@latex/texraResponseTextProcessing';
import type {
  FileLocation,
  MediaAttachmentKind,
  ToolFileAttachment,
  ToolResult,
} from '@shared/schemas';

// Local imports - model handlers
import { ModelHandler } from './ModelHandler';

// Third-party imports
import type { ModelConfig } from 'llm-zoo';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import type { CompletionUsage } from 'openai/resources/completions';

interface ValidationResponse {
  text: string;
  usage: CompletionUsage;
  stopReason: ProviderStopReason;
  toolCalls?: SdkToolCall[];
}

const VALIDATION_OUTPUT = `\\section{Validated CLI Runtime}

This document was produced by the internal TeXRA CLI validation model handler.
`;

const WORKFLOW_SCRIPT_VALIDATION_SOURCE = `export const meta = {
  name: 'cli-workflow-script-validation-v2',
  description: 'Solve three mathematical problems through the CLI',
  phases: [{ title: 'Solve' }],
  tasks: [
    { id: 'number-theory', label: 'Solve the Diophantine equation', phase: 'Solve' },
    { id: 'linear-algebra', label: 'Classify the matrix', phase: 'Solve' },
    { id: 'probability', label: 'Compute the stopping probability', phase: 'Solve' },
  ],
}
const schema = {
  type: 'object',
  additionalProperties: false,
  required: ['answer', 'derivation', 'check'],
  properties: {
    answer: { type: 'string' },
    derivation: { type: 'string' },
    check: { type: 'string' },
  },
}
phase('Solve')
const results = await parallel([
  () => agent('Find all integer solutions to x^2 - y^2 = 45.', { id: 'number-theory', agentName: 'prover', schema }),
  () => agent('Classify a real 3 by 3 matrix with A^2 = A and trace(A) = 2.', { id: 'linear-algebra', agentName: 'prover', schema }),
  () => agent('Compute whether HHT or THH appears first for a fair coin.', { id: 'probability', agentName: 'prover', schema }),
])
return { solutions: results.map((result) => result?.structured ?? null) }`;

function validationToolCall(name: string, input: unknown): SdkToolCall {
  const callId = `validation-${name}`;
  const argumentsJson = JSON.stringify(input);
  return {
    provider: 'openai',
    callId,
    name,
    input: argumentsJson,
    raw: {
      id: callId,
      type: 'function',
      function: { name, arguments: argumentsJson },
    },
  };
}

function mathematicalValidationOutput(messages: unknown[]): {
  answer: string;
  derivation: string;
  check: string;
} {
  const prompt = JSON.stringify(messages);
  if (prompt.includes('x^2 - y^2')) {
    return {
      answer:
        '(x,y) = (±23,±22), (±9,±6), and (±7,±2), with independent signs.',
      derivation:
        'Factor (x-y)(x+y)=45. The integer factor pairs of 45 with equal parity are (±1,±45), (±3,±15), and (±5,±9), including reversed signs. Solving x=(a+b)/2 and y=(b-a)/2 gives exactly the listed solutions.',
      check:
        'The factorization is bijective because x-y and x+y are odd divisors of 45; direct substitution gives differences of squares 45.',
    };
  }
  if (prompt.includes('A^2 = A')) {
    return {
      answer: 'A is similar over R to diag(1,1,0), and det(I+A)=4.',
      derivation:
        'The minimal polynomial divides t(t-1), whose roots are distinct, so A is diagonalizable with eigenvalues 0 and 1. The trace is the multiplicity of 1, hence it is 2.',
      check: 'I+A is similar to diag(2,2,1), whose determinant is 4.',
    };
  }
  return {
    answer: 'The probability that HHT appears before THH is 1/4.',
    derivation:
      'Track the longest suffix that is a prefix of either target: empty, H, HH, T, and TH. First-step recursion gives p_empty=(p_H+p_T)/2, p_H=(p_HH+p_T)/2, p_HH=(p_HH+1)/2, p_T=(p_TH+p_T)/2, and p_TH=p_T/2. Hence p_HH=1, p_T=p_TH=0, p_H=1/2, and p_empty=1/4.',
    check:
      'Substitution satisfies every state equation and uses absorbing values 1 after HHT and 0 after THH.',
  };
}

/**
 * Internal model handler used only by the CLI packaged-runtime validation gate.
 *
 * This handler is intentionally below `executeAgent()`: the CLI still parses
 * arguments, initializes the platform, calls the real shared runtime, and lets
 * the workflow flow write and extract output files. It is not a user-visible
 * model provider and must only be enabled by the package validation script.
 */
export class ModelHandlerValidation extends ModelHandler<
  ChatCompletionMessageParam,
  ValidationResponse['usage'],
  SdkToolCall,
  unknown,
  ValidationResponse
> {
  constructor(
    config: ModelConfig,
    responseTextProcessing?: ResponseTextProcessing,
  ) {
    super(config, responseTextProcessing);
    this.capabilities.supportsVision = false;
    this.capabilities.supportsFunctionCalling = true;
    this.capabilities.supportsAssistantPrefill = false;
  }

  async getClient(): Promise<unknown> {
    return {};
  }

  async createResponse(
    options: CreateResponseOptions<ChatCompletionMessageParam, unknown>,
  ): Promise<
    CreateResponseResult<ValidationResponse, ChatCompletionMessageParam>
  > {
    let toolCalls: SdkToolCall[] | undefined;
    if (process.env.TEXRA_INTERNAL_VALIDATE_WORKFLOW_SCRIPT === '1') {
      const toolNames = new Set(options.tools?.map((tool) => tool.name));
      const hasToolResult = options.messages.some(
        (message) => message.role === 'tool',
      );
      if (toolNames.has('submit_output')) {
        toolCalls = [
          validationToolCall(
            'submit_output',
            mathematicalValidationOutput(options.messages),
          ),
        ];
      } else if (!hasToolResult && toolNames.has('delegate_multi_agents')) {
        toolCalls = [
          validationToolCall('delegate_multi_agents', {
            agent: 'correct',
            script: WORKFLOW_SCRIPT_VALIDATION_SOURCE,
          }),
        ];
      }
    }
    return {
      response: {
        text: toolCalls
          ? ''
          : `<documents><document name="paper.polished.tex">${VALIDATION_OUTPUT}</document></documents>`,
        usage: {
          prompt_tokens: 1,
          completion_tokens: 1,
          total_tokens: 2,
        },
        stopReason: toolCalls ? 'tool_calls' : 'STOP',
        ...(toolCalls && { toolCalls }),
      },
    };
  }

  async initializeMessages(
    userPrefix: string,
    userRequest: string,
  ): Promise<ChatCompletionMessageParam[]> {
    return [{ role: 'user', content: `${userPrefix}\n\n${userRequest}` }];
  }

  async createRoundMessages(
    messages: ChatCompletionMessageParam[],
    userMessage: string,
  ): Promise<ChatCompletionMessageParam[]> {
    return [...messages, { role: 'user', content: userMessage }];
  }

  createMediaContent(_mediaMessage: MediaEntry[]): unknown[] {
    return [];
  }

  extractResponse(responseObject: ValidationResponse): ExtractResponseResult {
    return {
      text: this.postProcessResponse(responseObject.text),
      usage: responseObject.usage,
      stopReason: responseObject.stopReason,
    };
  }

  protected appendUserText(
    messages: ChatCompletionMessageParam[],
    text: string,
  ): void {
    messages.push({ role: 'user', content: text });
  }

  protected appendTextToLastAssistantMessage(
    _messages: ChatCompletionMessageParam[],
    _text: string,
    _options?: { afterContinuationPrompt?: boolean; fallbackText?: string },
  ): boolean {
    return false;
  }

  addContinueMessage(
    _messages: ChatCompletionMessageParam[],
    _workspaceState: AgentWorkspaceState,
    _agentSetting: AgentSetting,
  ): void {
    // The validation model always produces a complete response.
  }

  computePrice(_responseUsage: ValidationResponse['usage']): number {
    return 0;
  }

  normalizeUsage(
    rawUsage: ValidationResponse['usage'],
    responseTimeMs: number,
  ): NormalizedUsage {
    return {
      inputTokens: rawUsage.prompt_tokens,
      outputTokens: rawUsage.completion_tokens,
      cost: 0,
      responseTimeMs,
      provider: 'unknown',
    };
  }

  updateMessageContent(
    messages: ChatCompletionMessageParam[],
    _bestConnector: string,
    newResponse: string,
    _workspaceState: AgentWorkspaceState,
  ): void {
    messages.push(this.createAssistantMessage(newResponse));
  }

  shouldContinue(
    _stopReason: ProviderStopReason,
    _newResponse: string,
    _agentSetting: AgentSetting,
  ): boolean {
    return false;
  }

  processThinkingBlock(
    _responseObject: ValidationResponse,
    _workspaceState?: AgentWorkspaceState,
  ): string | null {
    return null;
  }

  extractToolUse(responseObject: ValidationResponse): SdkToolCall[] {
    return responseObject.toolCalls ?? [];
  }

  async createBatchedToolUseFollowUpMessages(
    entries: Array<{
      call: SdkToolCall;
      result: ToolResult;
      attachments: ToolFileAttachment[];
    }>,
    _workspaceState: AgentWorkspaceState | undefined,
    text: string | undefined,
  ): Promise<ChatCompletionMessageParam[]> {
    return entries.map(({ result }, index) => ({
      role: 'tool',
      tool_call_id: 'validation-tool-call',
      content:
        index === 0 && text
          ? `${text}\n${JSON.stringify(result)}`
          : JSON.stringify(result),
    }));
  }

  async createUserFollowUpMessages(
    messages: ChatCompletionMessageParam[],
    userMessage: string,
  ): Promise<ChatCompletionMessageParam[]> {
    return [...messages, { role: 'user', content: userMessage }];
  }

  createAssistantMessage(text: string): ChatCompletionMessageParam {
    return { role: 'assistant', content: text };
  }

  prependTextToUserMessage(
    messages: ChatCompletionMessageParam[],
    text: string,
  ): void {
    const last = messages.at(-1);
    if (!last || last.role !== 'user' || typeof last.content !== 'string') {
      messages.push({ role: 'user', content: text });
      return;
    }
    last.content = `${text}\n${last.content}`;
  }

  async addMediaToUserMessage(
    _messages: ChatCompletionMessageParam[],
    _mediaFiles: FileLocation[],
  ): Promise<MediaAttachmentKind[]> {
    // The validation model is text-only.
    return [];
  }
}
