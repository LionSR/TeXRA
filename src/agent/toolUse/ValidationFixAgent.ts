// Standard library imports
import * as path from 'path';
import * as vscode from 'vscode';

// Third-party imports
import { XMLValidator } from 'fast-xml-parser';

// Local imports - core
import { BaseToolUseAgent } from './BaseToolUseAgent';
import { loadAgentSettingAndPrompts } from '@agent/runtime/agentLoad';

// Local imports - types
import { AgentPrompt, AgentSetting } from '@agent/core/AgentDataclass';
import {
  ValidationResult,
  BaseError,
  XMLValidationError,
} from '@tools/anthropic/types';
import { LinterMessage } from '@frontend/latex/linter';
import { WorkspaceFS } from '@utils/files';
import * as linterUtils from '@frontend/latex/linter';
import * as logger from '@logger/logUtils';

const CHANNEL = 'ValidationFixAgent';
logger.initialize(CHANNEL);

export type ValidatorType = 'latexLinter' | 'xmlValidator';

type ErrorFor<T extends ValidatorType> = T extends 'latexLinter'
  ? LinterMessage[]
  : XMLValidationError;

export class ValidationFixAgent<
  T extends ValidatorType,
> extends BaseToolUseAgent<ErrorFor<T>> {
  private prompts: AgentPrompt = {
    systemPrompt: '',
    userPrefix: '',
    userRequest: '',
    userReflect: '',
  };
  private settings: AgentSetting | null = null;
  private validator: T;

  protected constructor(type: T) {
    super();
    this.validator = type;
  }

  public static async create<T extends ValidatorType>(
    type: T,
    context: vscode.ExtensionContext,
  ): Promise<ValidationFixAgent<T>> {
    const agent = new ValidationFixAgent<T>(type);
    await agent.init(context);
    return agent;
  }

  protected async init(context: vscode.ExtensionContext): Promise<void> {
    const agentPath = path.join(
      context.extensionPath,
      'resources',
      'tool_use_agents',
    );
    const [settings, prompts] = await loadAgentSettingAndPrompts(
      agentPath,
      this.getYamlName(),
    );
    this.prompts = prompts;
    this.settings = settings;
    const defaultTools =
      this.validator === 'latexLinter'
        ? ['text_editor', 'diagnostics']
        : ['text_editor'];
    this.setConfiguredTools((settings as any).tools || defaultTools);
  }

  private getYamlName(): string {
    return this.validator === 'latexLinter'
      ? 'tex_linter_fix'
      : 'xml_validator';
  }

  protected async validateFile(
    filePath: string,
  ): Promise<ValidationResult<ErrorFor<T>>> {
    if (this.validator === 'latexLinter') {
      return (await this.validateLatexFile(filePath)) as ValidationResult<
        ErrorFor<T>
      >;
    }
    return (await this.validateXmlFile(filePath)) as ValidationResult<
      ErrorFor<T>
    >;
  }

  private async validateLatexFile(
    filePath: string,
  ): Promise<ValidationResult<LinterMessage[]>> {
    const issues = await linterUtils.getLinterMessages(filePath);
    return issues.length === 0
      ? { isValid: true }
      : { isValid: false, error: issues };
  }

  private async validateXmlFile(
    filePath: string,
  ): Promise<ValidationResult<XMLValidationError>> {
    const content = await WorkspaceFS.readFile(filePath);
    const result = XMLValidator.validate(content, {
      allowBooleanAttributes: true,
    });
    if (result === true) {
      return { isValid: true };
    }
    const error: XMLValidationError = {
      message: result.err.msg,
      line: result.err.line,
      code: 'xml-validation-error',
      data: result,
    };
    return { isValid: false, error };
  }

  protected getErrorContext(content: string, error: ErrorFor<T>): string {
    let line = 1;
    if (this.validator === 'latexLinter' && Array.isArray(error)) {
      const first = error.find((e) => (e as any).line);
      line = (first as any)?.line ?? 1;
    } else if (
      this.validator === 'xmlValidator' &&
      (error as XMLValidationError).line
    ) {
      line = (error as XMLValidationError).line!;
    }
    return this.getContentAroundLine(content, line, this.contextLines);
  }

  protected createSystemMessage(
    _validation: ValidationResult<ErrorFor<T>>,
  ): string {
    return this.prompts.systemPrompt;
  }

  protected createInitialUserMessage(
    _validation: ValidationResult<ErrorFor<T>>,
    filePath: string,
    errorContext: string,
  ): string {
    return this.prompts.userPrefix
      .replace('{{FILE}}', filePath)
      .replace('{{ERROR_CONTEXT}}', errorContext);
  }

  protected createFollowUpMessage(
    _validation: ValidationResult<ErrorFor<T>>,
    isFixed: boolean,
    _currentIteration: number,
  ): string {
    return isFixed ? 'All issues fixed.' : this.prompts.userRequest;
  }
}
