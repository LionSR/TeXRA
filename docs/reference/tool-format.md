# Tool Definition Format

Some model providers allow calling functions ("tools") during generation.
Model handlers supporting this feature accept a `tools` array when creating a response.

Each tool definition must include at least a `name`.
Additional fields depend on the provider. A typical entry looks like:

```ts
const tools: ToolDefinition[] = [
  {
    name: 'searchWeb',
    description: 'Perform a web search',
    parameters: {
      type: 'object',
      /* JSON schema properties */
    },
  },
];
```

`parameters` should contain a valid JSON Schema object describing the tool
inputs. Include `type: 'object'` at the root to satisfy providers like
Anthropic. The definition is compatible with OpenAI
(`ChatCompletionTool['function']['parameters']`), Anthropic
(`Tool['input_schema']`), and Google Gemini (`FunctionDeclaration.parameters`).
Refer to your provider's documentation for the full schema details.
