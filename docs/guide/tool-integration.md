# Tool Integration

TexRA enhances AI capabilities by integrating with specialized external tools for academic research. This approach follows Andrew Ng's framework for building effective AI agents, particularly focusing on tool use as a key design pattern.

## Understanding Tool Integration

While language models are powerful, they benefit from specialized tools for specific tasks. TexRA's tool integration:

1. Leverages external programs for specialized tasks
2. Provides structured data to the AI for better context
3. Extracts and processes information that would be difficult for the AI alone
4. Ensures consistent formatting and processing of academic content

## Core Integrated Tools

TexRA integrates several key tools specifically designed for academic research:

### LaTeX Tools

#### latexdiff

**Purpose**: Compare LaTeX documents and visualize changes with color-coding.

**How it's used**:

- Compares original and modified documents
- Highlights additions, deletions, and modifications
- Generates a visual diff document
- Aids in reviewing changes between versions

**Integration in TexRA**:

- Accessible directly from the LaTeXdiffs section
- Automated diff generation after processing documents
- Support for comparing with git commits via latexdiff-vc
- Pack/clean functions for managing diff outputs

<!-- ![LaTeX Diff Example](/images/latexdiff-example.png) -->

#### latexindent

**Purpose**: Format LaTeX code with consistent indentation and structure.

**How it's used**:

- Applies consistent indentation to LaTeX files
- Structures environments, commands, and sections
- Makes code more readable and maintainable
- Standardizes document formatting

**Integration in TexRA**:

- Available via the "Indent TeX" command
- Automated indentation of generated documents
- Configurable through settings:

```json
"coauthor.latex.latexindentConfig": "/path/to/config"
```

#### texcount

**Purpose**: Analyze document statistics including word count, heading count, and math elements.

**How it's used**:

- Counts words in text, headers, and captions
- Tracks mathematical formulas and equations
- Provides detailed document statistics
- Helps assess document complexity and length

**Integration in TexRA**:

- Available via the "Count Words in Current TeX File" command
- Optional integration in prompts via "Attach TeX Count" option
- Helps AI understand document structure and complexity

### Figure Processing Tools

#### GraphicsMagick/ImageMagick

**Purpose**: Process images and convert between formats.

**How it's used**:

- Converts PDFs to images for visualization
- Processes image formats for compatibility
- Resizes and adjusts images as needed
- Creates viewable previews of figures

**Integration in TexRA**:

- Automatic processing of figures for AI vision
- Creation of viewable previews from PDFs
- Support for image extraction and manipulation

#### Ghostscript

**Purpose**: Process PDF documents and convert between formats.

**How it's used**:

- Renders PDFs for image extraction
- Processes complex document formats
- Enables multi-page document handling
- Supports high-quality image extraction

**Integration in TexRA**:

- Used with GraphicsMagick/ImageMagick for PDF processing
- Ensures high-quality figure extraction
- Supports TikZ figure compilation

### Git Integration

**Purpose**: Access version history and manage document changes.

**How it's used**:

- Retrieves commit history for comparison
- Enables latexdiff-vc for version comparison
- Tracks document evolution over time
- Supports collaborative workflows

**Integration in TexRA**:

- Commit listing in the LaTeXdiffs section
- Support for comparing against previous versions
- Integration with latexdiff-vc for visual diffs

## Tool Configuration Options

TexRA provides several ways to configure tool integration:

### Tool Config Dropdown

The "Tool Config" dropdown in the main interface allows you to enable or disable specific tool integrations:

- **Reflect**: Enable the AI's self-reflection mechanism
- **Attach TeX Count**: Include document statistics in prompts
- **Use Prefill from Input**: Use document content as initial text
- **Print Input Prompt**: Save generated prompts for debugging

<!-- ![Tool Config Options](/images/tool-config-options.png) -->

### Auto Extract Options

The "Auto Extract" dropdown provides options for automatic extraction:

- **Figures**: Automatically extract image references
- **TikZ Figures**: Automatically extract and compile TikZ figures

### VS Code Settings

Configure tool integration through VS Code settings:

```json
// LaTeX tools configuration
"coauthor.latex.latexindentConfig": "/path/to/latexindent.yaml",
"coauthor.latex.tikzInputDirectory": "/path/to/tikz/inputs",
"coauthor.latex.includeWorkspaceInTexinputs": true,

// Tool configuration
"coauthor.model.useStreaming": true,
"coauthor.model.useStreamingAnthropicReasoning": true,
"coauthor.agent.pauseForConfirmation": false,

// Git configuration
"coauthor.git.numberOfCommitsToShow": 20
```

## How Tool Integration Works

Behind the scenes, TexRA orchestrates a series of tool operations:

### Document Analysis Workflow

1. **Input Processing**:

   - TeX files are parsed to extract structure
   - texcount analyzes document statistics
   - Figures are extracted and processed
   - TikZ code is compiled into viewable images

2. **AI Processing**:

   - Tool outputs are incorporated into prompts
   - The AI leverages this structured information
   - Responses reference tool-provided data
   - Tool outputs guide the AI's understanding

3. **Output Processing**:
   - Generated content is formatted with latexindent
   - Diffs are created with latexdiff
   - Figures are extracted and compiled
   - Statistics are gathered for verification

## Leveraging Tools Effectively

To get the most from TexRA's tool integration:

### For Document Statistics

Enable "Attach TeX Count" when:

- Working with complex documents
- Needing to preserve document structure
- Making targeted changes to specific sections
- Analyzing document composition

### For Figure Processing

Enable auto-extraction options when:

- Working with documents containing figures
- Creating or modifying TikZ diagrams
- Needing the AI to understand visual elements
- Wanting figure improvements

### For Version Comparison

Use LaTeX diff features when:

- Tracking changes between versions
- Reviewing AI-generated modifications
- Comparing against previous work
- Preparing to merge changes

### For Document Formatting

Use latexindent features when:

- Standardizing document formatting
- Preparing for collaboration
- Improving code readability
- Ensuring consistent style

## Advanced Tool Integration

### Custom Tool Chains

For advanced workflows, you can chain multiple tools:

1. **Extract and Improve Figures**:

   - Extract TikZ figures with auto-extraction
   - Use the `draw` agent to enhance them
   - Reintegrate improved figures into your document

2. **Analyze and Enhance Structure**:

   - Use texcount to analyze document composition
   - Apply targeted improvements with specific agents
   - Verify changes with latexdiff

3. **Version Management Workflow**:
   - Use git integration to track document evolution
   - Apply intelligent merge to combine versions
   - Verify changes with latexdiff

### External Tool Integration

TexRA can work alongside other VS Code extensions:

- **LaTeX Workshop**: For compilation and preview
- **GitLens**: For enhanced git visualization
- **Remote Development**: For working with remote files

Configure these tools to work together:

```json
"latex-workshop.latex.outDir": "%DIR%/build",
"coauthor.files.ignored.directories": ["build"]
```

## Troubleshooting Tool Integration

If you encounter issues with tool integration:

### LaTeX Tools

- Verify tool installation with command-line checks
- Ensure proper PATH configuration
- Check for compatibility issues between tools
- Verify LaTeX package availability

### Image Processing

- Confirm GraphicsMagick/ImageMagick installation
- Check Ghostscript compatibility
- Verify file permissions for temporary directories
- Check for format compatibility issues

### Git Integration

- Ensure your project is a git repository
- Check git installation and configuration
- Verify commit history accessibility
- Check for large repository performance issues

## Next Steps

Now that you understand TexRA's tool integration, you might want to explore:

- [TikZ Figures](/guide/tikz-figures) - Learn more about working with figures
- [LaTeX Diff](/guide/latex-diff) - Explore document comparison features
- [Configuration](/guide/configuration) - Customize TexRA's tool integration
