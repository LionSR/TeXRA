export type ModelClient =
  | import('openai').default
  | import('@anthropic-ai/sdk').Anthropic
  | import('@google/genai').GoogleGenAI;
