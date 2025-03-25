# AI Models

CoAuthor supports a variety of language models from different providers. Each model has specific strengths, capabilities, and pricing considerations. This guide will help you choose the right model for your tasks.

## Model Overview

CoAuthor organizes models into several categories based on their providers:

1. **Anthropic Models** (Claude family)
2. **OpenAI Models** (GPT-4 and O-series)
3. **Google Models** (Gemini family)
4. **Other Models** (via OpenRouter)

## Anthropic Models

Anthropic's Claude models excel at following detailed instructions, understanding context, and producing high-quality academic writing.

### Claude 3.7 Sonnet (sonnet37)

**Key Features:**

- Excellent context understanding up to 200K tokens
- Strong academic writing capabilities
- Good at following complex instructions
- Fast response times for medium-complexity tasks

**Best For:**

- Day-to-day academic writing assistance
- Handling medium to complex documents
- Tasks requiring strong reasoning ability

**Example Use:**

```
Agent: polish
Model: sonnet37
Instruction: Improve the clarity of my methodology section while preserving all technical details and mathematical notation.
```

### Claude 3.7 Sonnet with Thinking (sonnet37T)

**Key Features:**

- Same capabilities as sonnet37
- Enhanced reasoning through explicit thinking
- Shows work for complex problems
- Better for multi-step reasoning tasks

**Best For:**

- Complex editing tasks
- Mathematical reasoning
- Detailed analysis

**Example Use:**

```
Agent: correct
Model: sonnet37T
Instruction: Find and fix errors in my mathematical derivations, focusing on dimensional consistency.
```

### Claude 3 Opus (opus)

**Key Features:**

- Highest quality output among Anthropic models
- Excellent nuanced understanding
- Strongest reasoning capabilities
- Higher cost than other Claude models

**Best For:**

- Critical documents needing highest quality
- Complex transformations between formats
- Sophisticated editing tasks

**Example Use:**

```
Agent: paper2note
Model: opus
Instruction: Transform this complex research paper into comprehensive lecture notes with insightful explanations of difficult concepts.
```

### Claude 3.5 Sonnet (sonnet35)

**Key Features:**

- Good balance of quality and performance
- Lower cost than Claude 3.7 models
- 200K token context window

**Best For:**

- Everyday academic writing tasks
- Draft improvement
- Standard corrections

**Example Use:**

```
Agent: correct
Model: sonnet35
Instruction: Fix grammar issues and improve sentence structure without changing content.
```

## OpenAI Models

OpenAI models provide strong reasoning capabilities and are particularly effective for creative and technical tasks.

### OpenAI O1 (o1)

**Key Features:**

- Advanced reasoning capabilities
- High-quality mathematical understanding
- Built-in thinking process
- Higher cost than GPT-4 models

**Best For:**

- Complex technical content
- Creative figure creation
- Mathematical derivations

**Example Use:**

```
Agent: draw
Model: o1
Instruction: Create a detailed TikZ figure of a 3D neural network architecture with labeled components.
```

### OpenAI O1 Mini (o1-)

**Key Features:**

- Scaled-down version of O1
- Good reasoning at lower cost
- Faster responses
- Limited system prompt support

**Best For:**

- Simpler reasoning tasks
- Budget-conscious projects
- Basic figure creation

**Example Use:**

```
Agent: txt2tex
Model: o1-
Instruction: Convert this plain text draft into properly formatted LaTeX with appropriate sectioning.
```

### GPT-4o (gpt4o)

**Key Features:**

- Strong multimodal capabilities
- Good performance for most tasks
- More affordable than O1 models
- Vision capabilities for image understanding

**Best For:**

- General-purpose academic writing
- Image-based reasoning
- Visual explanation tasks

**Example Use:**

```
Agent: polish
Model: gpt4o
Instruction: Improve the introduction and discussion sections of my paper, focusing on improving flow and clarity.
```

### GPT-4o Mini (gpt4o-)

**Key Features:**

- Cost-effective version of GPT-4o
- Good balance of quality and affordability
- Fast performance

**Best For:**

- Routine editing tasks
- Draft improvement
- Quick corrections

**Example Use:**

```
Agent: correct
Model: gpt4o-
Instruction: Fix typos and minor grammatical issues throughout the document.
```

## Google Models

Google's Gemini models offer strong performance with competitive pricing and excellent multimodal capabilities.

### Gemini 2.0 Pro (gemini2p)

**Key Features:**

- Strong reasoning abilities
- Excellent image understanding
- Large context window
- Competitive pricing

**Best For:**

- General academic writing tasks
- Image-based reasoning
- Large document processing

**Example Use:**

```
Agent: polish
Model: gemini2p
Instruction: Enhance the clarity of this literature review while maintaining all key references and arguments.
```

### Gemini 2.0 Flash Thinking (gemini2fT)

**Key Features:**

- Shows reasoning process explicitly
- Fast performance
- Cost-effective
- Good for step-by-step tasks

**Best For:**

- Tasks requiring visible reasoning
- Budget-conscious projects
- Teaching materials

**Example Use:**

```
Agent: paper2slide
Model: gemini2fT
Instruction: Convert this paper into presentation slides, showing step-by-step derivations for complex equations.
```

### Gemini 2.0 Flash (gemini2f)

**Key Features:**

- Fastest Gemini model
- Most cost-effective option
- Good for simple tasks
- Native PDF support

**Best For:**

- Simple corrections
- Routine formatting
- PDF-based tasks

**Example Use:**

```
Agent: correct
Model: gemini2f
Instruction: Fix formatting issues and typos in this document. Ensure consistent citation style.
```

## Other Models (via OpenRouter)

CoAuthor supports additional models through OpenRouter integration, allowing access to models from other providers.

### Llama 3.1 (llama31)

**Key Features:**

- Open source performance
- Large context window
- Competitive performance with Claude/GPT

**Example Use:**

```
Agent: polish
Model: llama31
Instruction: Improve the clarity of this document while maintaining the existing technical content.
```

### DeepSeek-V3 (DSV3)

**Key Features:**

- Strong technical performance
- Cost-effective
- Good for programming tasks

**Example Use:**

```
Agent: draw
Model: DSV3
Instruction: Create a TikZ diagram showing the architecture of the algorithm described in section 3.
```

## Choosing the Right Model

When selecting a model, consider these factors:

### 1. Task Complexity

- **Simple Tasks** (typo correction, formatting): Use lighter models like `gemini2f`, `gpt4o-`, or `haiku35`
- **Medium Complexity** (polishing, basic figures): Use `sonnet35`, `gpt4o`, or `gemini2p`
- **Complex Tasks** (paper transformation, advanced figures): Use `sonnet37`, `opus`, or `o1`

### 2. Response Speed

From fastest to slowest:

1. `gemini2f`, `haiku35`
2. `gpt4o-`, `sonnet35`
3. `gpt4o`, `sonnet37`
4. `opus`, `o1`, `gemini25p`

### 3. Cost Considerations

From lowest to highest cost per token:

1. `gemini2f`, `gpt4o-`, `haiku35`
2. `gemini2p`, `sonnet35`
3. `gpt4o`, `sonnet37`
4. `opus`, `o1`

### 4. Special Capabilities

- **Native PDF Support**: `gemini2f`, `gemini2p`
- **Explicit Reasoning**: `sonnet37T`, `gemini2fT`, `o1`
- **Longest Context Window**: `gemini2p` (2M tokens)
- **Best Vision Understanding**: `gpt4o`, `gemini2p`

## Model Configuration

The model selection dropdown in the CoAuthor interface shows all available models. The list of available models can be customized in VS Code settings:

```json
"coauthor.models": [
  "sonnet37T",
  "sonnet37",
  "sonnet35",
  "opus",
  "o3-",
  "o1",
  "o1-",
  "gpt45",
  "gpt4o",
  "gpt4ol",
  "gemini2p",
  "gemini2f",
  "gemini2fT",
  "DSV3",
  "DSR1"
]
```

## Using OpenRouter

CoAuthor supports accessing models through [OpenRouter](https://openrouter.ai/), which can provide:

1. Access to models not directly available via their original API
2. Potential cost savings through competitive pricing
3. Access to specialized models like Llama and DeepSeek

To enable OpenRouter:

1. Obtain an OpenRouter API key
2. Set it in CoAuthor's API key settings
3. Enable OpenRouter in VS Code settings:

```json
"coauthor.model.useOpenRouter": true
```

## Streaming Support

For long responses or reasoning-heavy models, you can enable streaming to see incremental results:

```json
"coauthor.model.useStreaming": true,
"coauthor.model.useStreamingAnthropicReasoning": true,
"coauthor.model.useStreamingOpenAIReasoning": true
```

## Performance Tips

1. **Match the model to the task**: Use lighter models for simple tasks, reserve powerful models for complex work
2. **Use reasoning models strategically**: Enable explicit thinking for complex tasks that benefit from step-by-step reasoning
3. **Consider context window limits**: For very large documents, choose models with larger context windows
4. **Balance quality and cost**: Higher-quality models are more expensive; use them when quality is critical

## Recommended Model-Agent Pairings

| Task                 | Recommended Model | Alternative |
| -------------------- | ----------------- | ----------- |
| Basic corrections    | `gemini2f`        | `gpt4o-`    |
| Polishing writing    | `sonnet37`        | `gpt4o`     |
| Creating figures     | `o1`              | `sonnet37T` |
| Paper to notes       | `opus`            | `sonnet37`  |
| Paper to slides      | `sonnet37`        | `gemini2p`  |
| Merging documents    | `sonnet37`        | `gpt4o`     |
| Mathematical content | `o1`              | `sonnet37T` |
| Mathematical content | `gemini25p`       | `sonnet37T` |

## Next Steps

Now that you understand the different models available in CoAuthor, explore:

- [File Management](/guide/file-management) to learn how to work with multiple files
- [Tool Integration](/guide/tool-integration) to discover how CoAuthor leverages external tools
- [Advanced Usage](/guide/advanced-usage) for more sophisticated workflows
