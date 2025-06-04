# Using the OpenAI Responses API

The Responses API is OpenAI's latest method for interacting with models. It keeps the conversation state on the server, so you can continue a dialogue just by passing the `previous_response_id` of an earlier call.

```python
response_two = client.responses.create(
    model="gpt-4o-mini",
    input="tell me another",
    previous_response_id=response.id
)
```

Inputs use new item types like `input_text` and `input_image` instead of the older `text` or `image_url` fields. Outputs can be accessed via `response.output_text` or from the first item of `response.output`:

```python
print(response.output[0].content[0].text)
```

You can also use hosted tools such as web search directly:

```python
response = client.responses.create(
    model="gpt-4o",
    input=[{
        "role": "user",
        "content": [
            {"type": "input_text", "text": "What's new in AI today?"}
        ]
    }],
    tools=[{"type": "web_search"}]
)
```

This API is now supported by TeXRA's OpenAI model handler.
