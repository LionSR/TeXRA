# Multiple Output Processing

TexRA provides powerful capabilities for working with multiple files simultaneously. This guide explains how to process multiple input files and manage multiple outputs efficiently.

## Understanding Multiple Output Processing

Multiple output processing allows you to:

1. Process several related documents in a single operation
2. Maintain consistency across a collection of files
3. Apply the same improvements to multiple chapters or sections
4. Handle complex document structures split across files

This approach is particularly valuable for:

- Books with multiple chapters
- Theses with separate chapter files
- Paper collections with shared formatting
- Course materials with multiple related documents

## Enabling Multiple Output Mode

To work with multiple files:

### Step 1: Enable Multiple Input Files

1. Click the "▼" toggle next to "Input" in the file selection area
2. The multiple selection panel will expand
3. Use the "+" button to add files
4. Use "Opened Files" to add all currently open files

<!-- ![Multiple Input Selection](/images/multiple-input-selection.png) -->

### Step 2: Enable Multiple Outputs

1. Click the "▼" toggle next to "Multiple Outputs"
2. The multiple output panel will expand
3. Add output files corresponding to your input files
4. Optionally set a custom output filename pattern

<!-- ![Multiple Output Selection](/images/multiple-output-selection.png) -->

::: tip
By default, TexRA will use the same output naming pattern for all files:  
`original_filename_agent_r0_model.extension`
:::

## Processing Multiple Files

When working with multiple files, TexRA applies special processing:

### Sequential Processing

TexRA processes multiple files sequentially:

1. Each input file is analyzed individually
2. Files are processed in the order they appear in the list
3. Results are generated for each file separately
4. Outputs maintain the relationship to their corresponding inputs

### Maintaining Context

To maintain context across multiple files:

1. Order files logically (e.g., chapters in sequence)
2. Include any shared files (e.g., preambles, style files) as auxiliary files
3. Provide explicit instructions about maintaining consistency
4. Consider using the first file as a style reference

## Common Multiple Output Scenarios

### Book Chapters

Process multiple chapters of a book with consistent styling:

1. Select all chapter files as input files
2. Select the main style file as an auxiliary file
3. Use an instruction like:

```
Improve the writing style across all chapters. Ensure consistent terminology,
tone, and formatting throughout. Pay special attention to transitions between
chapters and maintaining a unified voice.
```

### Lecture Notes Series

Process a series of lecture notes with consistent formatting:

1. Select all lecture note files as input files
2. Select a template or style guide as a reference file
3. Use an instruction like:

```
Enhance these lecture notes by improving clarity, adding appropriate section
headings, and ensuring consistent formatting across all documents. Maintain
all mathematical notation and technical content exactly as written.
```

### Paper Sections

Process separate sections of a research paper:

1. Select introduction, methods, results, and discussion files
2. Select the bibliography as an auxiliary file
3. Use an instruction like:

```
Polish these paper sections to create a cohesive manuscript. Ensure consistent
terminology and citation style across all sections. Improve transitions between
sections and make sure that cross-references are appropriate.
```

## Custom Output Naming

For more control over output files:

### Using Output Name Override

1. Click the ">" toggle next to "Output Filename" in the Multiple Outputs section
2. Enter a custom filename pattern (including extension)
3. This pattern will be applied to all outputs

<!-- ![Output Name Override](/images/output-name-override.png) -->

### Custom Naming Patterns

For more complex naming needs:

- Use separate output files for each input with their own naming convention
- Arrange output files in the order corresponding to input files
- Use descriptive names that indicate the relationship to input files

## Processing Options for Multiple Files

When working with multiple files, consider these options:

### Reflect Option

Enabling the "Reflect" option with multiple files:

- The AI will process each file and then reflect on all files together
- This helps ensure consistency across outputs
- It may identify and fix inconsistencies between files
- Particularly valuable for maintaining unified style and terminology

### Attach TeX Count

With multiple files, the "Attach TeX Count" option:

- Provides statistics for each file individually
- Helps the AI understand the structure of each document
- Allows document-specific optimizations

### Auto-Extract Features

Auto-extraction works across all selected files:

- Figures are extracted from all input files
- TikZ diagrams are compiled from all input files
- Extracted content is available for all processing

## Reviewing Multiple Outputs

After processing multiple files:

### Individual Review

Review each output file individually:

1. Compare with the corresponding input file
2. Check for file-specific improvements
3. Verify that document-specific features are preserved

### Consistency Check

Verify consistency across all outputs:

1. Check for consistent terminology
2. Ensure unified style and formatting
3. Verify cross-references between documents
4. Confirm consistent citation style

### Batch Diff Generation

Generate diffs for all processed files:

1. Use LaTeX diff for each input-output pair
2. Review changes systematically
3. Look for inconsistent changes across files

## File Management for Multiple Outputs

Managing multiple output files effectively:

### Pack Operation

The "Pack" button with multiple files:

1. Creates a timestamped directory in the "History" folder
2. Moves all output files to this directory
3. Preserves the relationship between files
4. Maintains a clean workspace

### Clean Operation

The "Clean" button with multiple files:

1. Identifies all outputs for all processed files
2. Safely removes them from the workspace
3. Cleans up auxiliary files generated during processing

## Advanced Multiple File Techniques

### Sequential Processing with Different Agents

For complex workflows, apply different agents in sequence:

1. Process all files with the `correct` agent first
2. Pack the outputs
3. Use those outputs as inputs for the `polish` agent
4. Repeat with other agents as needed

### Combined Document Processing

For documents that will be combined later:

1. Process each file separately
2. Ensure consistent instructions across all files
3. Use the same model for all processing
4. Provide explicit instructions about eventual combination

### Split and Recombine

For very large documents:

1. Split the document into manageable chunks
2. Process each chunk separately
3. Use the same settings for all chunks
4. Recombine processed chunks into a final document

## Troubleshooting Multiple Output Processing

### Common Issues

**Problem**: Inconsistent styling across outputs

**Solutions**:

- Use more specific instructions about consistency
- Enable the "Reflect" option
- Process files sequentially in a logical order
- Provide a style guide as a reference file

**Problem**: Missing cross-references between files

**Solutions**:

- Include all related files as input or auxiliary files
- Specify the importance of maintaining cross-references
- Use the `merge` agent for final integration

**Problem**: Performance issues with many files

**Solutions**:

- Process smaller batches of files
- Use lighter models for initial processing
- Consider sequential processing with different agents
- Focus on most critical files first

## Best Practices

### File Organization

Organize your files effectively:

1. **Logical Ordering**: Arrange files in their logical sequence
2. **Clear Naming**: Use descriptive, consistent filenames
3. **Shared Resources**: Identify and include shared style files
4. **Output Management**: Plan your output organization in advance

### Instruction Crafting

Create effective instructions for multiple files:

1. **Emphasize Consistency**: Explicitly request consistency across files
2. **Specify Relationships**: Explain how files relate to each other
3. **Prioritize Elements**: Identify what aspects must remain consistent
4. **Define Document Roles**: Explain the purpose of each file

### Model Selection

Choose appropriate models for multiple file processing:

1. **Consistency-Focused**: Use Claude 3.7 Sonnet or Claude 3 Opus for best consistency
2. **Context-Aware**: Select models with large context windows for related files
3. **Efficiency**: For many similar files, consider faster models like Gemini Flash

## Next Steps

Now that you understand multiple output processing, you might want to explore:

- [File Management](/guide/file-management) - Learn more about effective file organization
- [Intelligent Merge](/guide/intelligent-merge) - Understand how to combine processed files
- [Best Practices](/reference/best-practices) - Discover recommended workflows for complex projects
