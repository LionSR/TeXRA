# Streaming model thinking

TeXRA highlights reasoning blocks from supported models in the ProgressBoard. Models that stream responses can also stream their `thinking` content so you can watch reasoning evolve in real time.

This note outlines a clean approach for aggregating streaming chunks and updating the UI.

## Aggregating chunks

Every model handler that supports streaming already gathers chunks from the provider. For example OpenAI models use `stream.finalMessage()` while Google GenAI collects chunks manually:

```ts
const stream = await chat.sendMessageStream({ message, config });
const fullParts: Part[] = [];
for await (const chunk of stream) {
  if (chunk.candidates?.[0]?.content?.parts) {
    fullParts.push(...chunk.candidates[0].content.parts);
  }
}
```

_(see `modelHandlerGoogleGenAI.ts` lines 276‑302)_

A similar loop exists in `modelHandlerOpenAI.ts` when `finalMessage()` is not available and reasoning content must be concatenated from `chunk.choices[0].delta` fields.

## Proposed helper

Add a `streamThinking()` utility to `ModelHandler` that accepts the streaming iterator and a provider‑specific parser. It would:

1. Maintain `accumulatedContent` and `accumulatedThinking` strings.
2. After each chunk, update these strings and log the current thinking block via `AgentLogger.info('Thinking content:\n' + accumulatedThinking)` so the ProgressBoard renders it with the `thinking` style.
3. When `finalMessage()` is supported, call it after the loop and update the last log entry with the complete text.

Each provider handler only supplies the parser that extracts `content` and `reasoning` fields from its chunk structure. This keeps streaming logic DRY while preserving provider specifics.

## Frontend update

The ProgressBoard already handles messages flagged as `thinking`. As chunks arrive the backend sends updated text; the frontend can simply replace the previous `thinking` block. When the final message resolves the block is replaced one last time with the full reasoning.

## Benefits

- Unified streaming logic across providers
- Minimal changes in individual handlers
- Real‑time display of model reasoning

This approach leverages existing message types and logging utilities without major refactoring.
