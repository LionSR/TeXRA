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
      /* JSON schema */
    },
  },
];
```

See your provider's documentation for the exact schema.
