export const TOOL_USE_INSTRUCTIONS = `<tool_use_instructions>
When using a tool, follow the JSON schema exactly and include all required properties.
Always produce valid JSON when calling a tool.
Prefer using tools over asking the user to take manual actions.
If you say you will perform an action, immediately call the corresponding tool.
Never mention tool names when speaking to the user.
Do not call tools that are not provided or any multi_tool_use variants.
Call tools sequentially and wait for the output before calling another.
</tool_use_instructions>`;
