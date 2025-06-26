// Standard library imports
import * as path from 'path';
import * as vscode from 'vscode';

// Third-party imports
import { XMLValidator } from 'fast-xml-parser';

// Local imports - core
import { BaseToolUseAgent } from './BaseToolUseAgent';
import { loadAgentSettingAndPrompts } from '@agent/runtime/agentLoad';

// Local imports - types
import { AgentPrompt } from '@agent/core/AgentDataclass';
import { ValidationResult, BaseError } from '@tools/anthropic/types';
import { LinterMessage } from '@frontend/latex/linter';
import { WorkspaceFS } from '@utils/files';
import * as linterUtils from '@frontend/latex/linter';
import * as logger from '@logger/logUtils';

const CHANNEL = 'ValidationFixAgent';
logger.initialize(CHANNEL);

export type ValidatorType = 'latexLinter' | 'xmlValidator';

export class ValidationFixAgent<
  ErrorType extends BaseError | BaseError[],
> extends BaseToolUseAgent<ErrorType> {
  private prompts: AgentPrompt = {
    systemPrompt: '',
    userPrefix: '',
    userRequest: '',
    userReflect: '',
  };
  private validator: ValidatorType;

  constructor(type: ValidatorType, context: vscode.ExtensionContext) {
    super();
    this.validator = type;
    const agentPath = path.join(
      context.extensionPath,
      'resources',
      'tool_use_agents',
    );
    loadAgentSettingAndPrompts(agentPath, this.getYamlName()).then(([, p]) => {
      this.prompts = p;
    });
  }

  private getYamlName(): string {
    return this.validator === 'latexLinter'
      ? 'tex_linter_fix'
      : 'xml_validator';
  }

  protected async validateFile(
    filePath: string,
  ): Promise<ValidationResult<ErrorType>> {
    if (this.validator === 'latexLinter') {
      const issues = await linterUtils.getLinterMessages(filePath);
      return issues.length === 0
        ? { isValid: true }
        : { isValid: false, error: issues as unknown as ErrorType };
    }
    const content = await WorkspaceFS.readFile(filePath);
    const result = XMLValidator.validate(content, {
      allowBooleanAttributes: true,
    });
    if (result === true) {
      return { isValid: true };
    }
    const error = {
      message: result.err.msg,
      line: result.err.line,
      code: 'xml-validation-error',
      data: result,
    } as unknown as ErrorType;
    return { isValid: false, error };
  }

  protected getErrorContext(content: string, error: any): string {
    const line = error?.line || 1;
    return this.getContentAroundLine(content, line, this.contextLines);
  }

  protected createSystemMessage(): string {
    return this.prompts.systemPrompt;
  }

  protected createInitialUserMessage(
    _validation: ValidationResult<ErrorType>,
    filePath: string,
    errorContext: string,
  ): string {
    return this.prompts.userPrefix
      .replace('{{FILE}}', filePath)
      .replace('{{ERROR_CONTEXT}}', errorContext);
  }

  protected createFollowUpMessage(
    _validation: ValidationResult<ErrorType>,
    isFixed: boolean,
  ): string {
    return isFixed ? 'All issues fixed.' : this.prompts.userRequest;
  }
}
