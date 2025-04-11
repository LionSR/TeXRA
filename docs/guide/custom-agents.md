# Custom Agents

TeXRA allows you to create custom agents tailored to your specific academic writing needs. This guide will walk you through the process of creating, configuring, and using custom agents.

## Understanding Agent Architecture

Before creating a custom agent, it's helpful to understand how agents are structured in TeXRA:

### Agent Components

Each agent consists of several key components:

1. **Agent Settings**: Define the agent's behavior, file handling, and operational parameters
2. **Agent Prompts**: Provide instructions for the AI model in different contexts
3. **Inheritance Relationships**: Allow agents to build upon other agents' capabilities

### Agent Types

TeXRA supports two main agent types:

- **Chain of Thought (CoT)**: Uses structured XML output with scratchpad thinking for complex reasoning
- **Direct**: Provides simpler, more straightforward output for less complex tasks

## Agent Configuration Files

Custom agents are defined using YAML configuration files. These files specify:

- Agent settings
- Prompt templates
- Inheritance relationships
- Required file patterns

## Creating Your First Custom Agent

Let's walk through the process of creating a custom agent:

### Step 1: Locate the Agents Directory

Custom agents live in a dedicated directory:

1. Open VS Code
2. Access the TeXRA sidebar (quantum deer icon)
3. Find "Custom Agents" in the folder explorer section

You can also set a custom agents directory in settings:

```json
"texra.explorer.agentsDirectory": "/path/to/custom/agents"
```

### Step 2: Create a New YAML File

1. Right-click on your desired directory
2. Select "New File"
3. Name the file `your_agent_name.yaml` (e.g., `literature_review.yaml`)

### Step 3: Configure Basic Agent Structure

Add the following basic structure to your YAML file:

```yaml
# Custom agent for [purpose]
# Author: [your name]
# Date: [creation date]

# Optional: inherit from an existing agent
inherits: polish

# Agent settings
settings:
  agentType: CoT # Can be CoT or direct
  documentTag: document
  temperature: 0.0
  prefills:
    - "<document>\n"
  outputExt: tex
  endTag: '</document>'
  isRewrite: true

# Agent prompts
prompts:
  systemPrompt: |
    You are an expert academic research assistant specialized in [your specific domain].
    Your task is to [describe the agent's primary purpose].

  userPrefix: |
    I need your help with [specific task]. Please [specific instructions].

  userRequest: |
    Please process the following document according to the instructions.

  userReflect: |
    Now review your work and make any necessary improvements. Focus on [specific aspects].
```

### Step 4: Customize Agent Settings

Modify the settings section to match your agent's requirements:

```yaml
settings:
  agentType: CoT # CoT for complex tasks, direct for simpler ones
  documentTag: document # XML tag for output wrapping
  temperature: 0.1 # Higher for more creative tasks, lower for precision
  prefills:
    - "<document>\n" # Initial text in the output
  outputExt: tex # Output file extension
  endTag: '</document>' # Signal for task completion
  isRewrite: true # Whether the agent rewrites content (vs. appending)

  # Optional: specify required files
  requiredFiles:
    TEMPLATE: path/to/template.tex

  # Optional: specify file patterns to look for
  filePatternsContain:
    - pattern: 'bibliography'
      varName: BIBLIOGRAPHY
      categories: ['auxiliaryFile', 'auxiliaryFiles']
```

### Step 5: Craft Effective Prompts

The prompts section is critical for agent behavior. Customize each prompt:

```yaml
prompts:
  systemPrompt: |
    You are an expert academic research assistant specialized in creating literature reviews for computer science papers.
    Your task is to analyze existing research papers and synthesize a comprehensive literature review that:
    1. Organizes works by themes and approaches
    2. Identifies relationships between different research directions
    3. Highlights gaps in the current literature
    4. Maintains formal academic language and proper citation style
    5. Follows a logical structure with clear progression

    When writing the literature review:
    - Use topic sentences to introduce each paragraph's main idea
    - Provide smooth transitions between sections
    - Group related works together rather than simply listing them chronologically
    - Compare and contrast different approaches
    - Maintain consistent terminology throughout

  userPrefix: |
    I need help creating a literature review based on the following papers. Please organize the literature into coherent themes,
    highlight connections between different works, and identify research gaps. Maintain proper academic style and citation format.

  userRequest: |
    Please process the provided papers and create a comprehensive literature review section.
    The research area is: {{INSTRUCTION}}

  userReflect: |
    Now review your literature review and improve it. Focus on:
    1. The logical structure and flow between paragraphs
    2. The thoroughness of coverage
    3. The balance between different research directions
    4. The clarity of your analysis and synthesis
    5. Proper citation formatting and consistency
```

### Step 6: Save and Reload

1. Save your YAML file
2. Reload VS Code window (Command Palette > "Developer: Reload Window")
3. Your custom agent should now appear in the agent dropdown menu

## Inheritance and Overriding

One powerful feature of TeXRA's agent system is inheritance, which allows you to build on existing agents:

### Basic Inheritance

```yaml
inherits: polish

settings:
  temperature: 0.2 # Override specific settings

prompts:
  userRequest: |
    # Override specific prompts
    Please polish this document with special attention to [specific aspect].
```

When using inheritance:

- Only specify the settings and prompts you want to override
- Other settings and prompts will be inherited from the parent
- You can chain inheritance (a child agent can inherit from another child)

### Inheritance Example: Creating a Domain-Specific Polish Agent

```yaml
# physics_polish.yaml
inherits: polish

settings:
  temperature: 0.0 # Physics requires precision

prompts:
  systemPrompt: |
    You are an expert academic editor specializing in physics papers. 
    Your task is to improve the clarity, flow, and precision of physics manuscripts.
    Pay special attention to:
    1. Correct usage of physics terminology and notation
    2. Consistency in variable naming and units
    3. Clarity in describing experimental setups and theoretical frameworks
    4. Proper formatting of equations and references to them
    5. Clear explanation of physical concepts for the intended audience

  userPrefix: |
    Please polish this physics document to enhance clarity and precision while maintaining all technical content.
    Pay special attention to equation formatting, consistent notation, and accurate physics terminology.
```

## Advanced Agent Configuration

For more specialized agents, you can use additional configuration options:

### Required Files

Specify files that your agent needs for processing:

```yaml
settings:
  requiredFiles:
    TEMPLATE: path/to/template.tex
    BIBFILE: path/to/bibliography.bib

  requiredFilesInternal:
    STYLE_GUIDE: styles/physics-style-guide.tex
```

These files will be available to the agent as variables in prompts:

```yaml
prompts:
  userPrefix: |
    Follow the style guide provided:

    {{STYLE_GUIDE_CONTENT}}
```

### File Pattern Matching

Configure your agent to find specific types of files:

```yaml
settings:
  filePatternsContain:
    - pattern: 'bibliography'
      varName: BIBLIOGRAPHY
      categories: ['auxiliaryFile', 'auxiliaryFiles']
    - pattern: 'media'
      varName: MAIN_FIGURE
      categories: ['mediaFile', 'mediaFiles']
```

These patterns help the agent automatically identify relevant files based on their names.

### Default Output Files

For agents that work with multiple files, specify default outputs:

```yaml
settings:
  defaultOutputFiles:
    - 'introduction.tex'
    - 'methods.tex'
    - 'results.tex'
    - 'discussion.tex'
```

## Custom Agent Examples

### Research Proposal Agent

```yaml
# research_proposal.yaml
inherits: write

settings:
  agentType: CoT
  temperature: 0.1

prompts:
  systemPrompt: |
    You are an expert academic grant writer specializing in research proposals.
    Your task is to help researchers draft compelling research proposals that:
    1. Clearly articulate the research question and its significance
    2. Present a well-structured literature review showing gaps
    3. Describe a feasible methodology with clear steps
    4. Outline expected outcomes and potential impacts
    5. Provide a realistic timeline and resource requirements

  userPrefix: |
    I need help drafting a research proposal on the following topic. Please create a structured proposal
    with all necessary sections following standard academic formats.

  userRequest: |
    Please create a research proposal based on the following information:
    Topic: {{INSTRUCTION}}

  userReflect: |
    Review this research proposal and improve it. Focus on:
    1. The clarity and significance of the research question
    2. The thoroughness of the literature review
    3. The feasibility of the proposed methodology
    4. The potential impact and innovation of the research
    5. The overall persuasiveness and academic ri
```
