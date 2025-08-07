# OpenAI Responses API

The Responses API is a recent addition to the OpenAI platform. It allows developers to build conversational tools by referencing the `previous_response_id` rather than sending the full message history on every request. TeXRA supports this API as an alternative to the Chat Completions API.

## Key differences

- **Continuations**: Provide `previous_response_id` from the prior response to continue a conversation. Only the new messages are sent.
- **Input types**: Message parts use `input_text` or `input_image` objects.
- **Output format**: Instead of `choices`, text is found in `response.output[0].content[0].text` (or `output_text`).
- **Instructions**: The `instructions` parameter applies only to the current request. When using `previous_response_id`, you must resend any system instructions you want applied.
- **No stop sequences**: The Responses API does not accept a `stop` parameter. If your agent requires an end tag, handle it in post-processing rather than sending it to the API.

See the [OpenAI Responses documentation](https://platform.openai.com/docs/api-reference/responses) for full details.

## Using with TeXRA

When `"texra.model.useOpenAIResponsesAPI"` is enabled, the extension automatically:

1. Converts chat message parts into `input_text`/`input_image` objects.
2. Tracks the last `response.id` and sends it as `previous_response_id` for subsequent rounds.
3. Reads the returned text from `output_text` or the `output` array.

This keeps requests small and simplifies conversation management.

The open-weight models `gpt-oss-120b` and `gpt-oss-20b` also use the
Responses API automatically, even if the setting isn't enabled.
