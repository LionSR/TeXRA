// Third-party imports
import type {
  ContentBlockParam,
  ToolResultBlockParam,
  ToolUseBlockParam,
} from '@anthropic-ai/sdk/resources/messages';

// Compile-time assertion helper ensuring SDK surface remains compatible.
type Assert<T extends true> = T;

export type ToolUseBlockParamExtendsContentBlockParam = Assert<
  ToolUseBlockParam extends ContentBlockParam ? true : false
>;

export type ToolResultBlockParamExtendsContentBlockParam = Assert<
  ToolResultBlockParam extends ContentBlockParam ? true : false
>;

export type ToolResultBlockParamAcceptsStringContent = Assert<
  string extends Exclude<ToolResultBlockParam['content'], undefined>
    ? true
    : false
>;
