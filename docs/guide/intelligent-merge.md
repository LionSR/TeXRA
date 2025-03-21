# Intelligent Merge

CoAuthor's intelligent merge feature allows you to seamlessly combine changes from multiple document versions or authors. This powerful capability goes beyond simple text merging by understanding the context and intent of changes, making it invaluable for collaborative academic writing.

## Understanding Intelligent Merge

Unlike traditional text merge tools that work line-by-line, CoAuthor's intelligent merge:

1. Analyzes the semantic content of both documents
2. Identifies substantive changes vs. stylistic differences
3. Preserves important content from both versions
4. Resolves conflicts intelligently based on context
5. Maintains consistent style and terminology

This approach is particularly valuable for academic writing, where precision and clarity are critical.

## When to Use Intelligent Merge

The intelligent merge feature is ideal for:

- **Collaborative Writing**: Combining contributions from multiple authors
- **Revision Cycles**: Incorporating feedback and changes from reviewers
- **Alternative Drafts**: Merging parallel development of different sections
- **Version Harmonization**: Bringing divergent document versions back together
- **Selective Updates**: Incorporating specific improvements while preserving core content

## Basic Merge Workflow

Here's how to perform a basic intelligent merge:

### Step 1: Select Files

In the LaTeXdiffs section of the CoAuthor panel:

1. **Base File**: Select the original document version
2. **Edited File**: Select the modified document version

<!-- ![Merge File Selection](/images/merge-file-selection.png) -->

::: tip File Selection Order
The Base File is typically your "main" or "canonical" version, while the Edited File contains changes you want to incorporate.
:::

### Step 2: Execute the Merge

Click the "Merge" button with the <i class="codicon codicon-merge"></i> icon.

CoAuthor will:

1. Analyze both documents
2. Identify meaningful changes
3. Create a new document combining the best elements of both

### Step 3: Review the Result

The merged document will be opened automatically. CoAuthor will:

1. Create a new file with naming pattern: `basename_merge_r0_model.tex`
2. Generate a diff file showing all changes
3. Log the merge process details in the ProgressBoard

## Advanced Merge Options

For more control over the merge process:

### Specifying Merge Priorities

You can guide the merge process through specific instructions:

1. In the CoAuthor main panel, select the `merge` agent
2. Choose your model (Claude 3.7 Sonnet recommended)
3. Provide specific instructions in the instruction box
4. Select your base and edited files
5. Execute the agent

**Example instruction:**

```
Merge the edited file into the base document with these priorities:
1. Retain all mathematical notation exactly as in the base file
2. Preserve all citations from both documents
3. Prefer the edited file's introduction and conclusion
4. Preserve base file terminology throughout
5. Adopt improved phrasing from the edited file where it enhances clarity
```

### Model Selection for Merging

Different models have different strengths for merging:

- **Claude 3.7 Sonnet**: Best overall balance of quality and performance
- **Claude 3 Opus**: Highest quality for critical documents
- **GPT-4o**: Good performance for merges with visual elements

You can select the model in the merge configuration.

## Handling Complex Merges

For particularly complex merge scenarios:

### Multi-Stage Merges

For documents with extensive changes:

1. Break the merge into logical sections
2. Merge each section separately with appropriate instructions
3. Combine the merged sections into a final document

### Conflict Resolution

When documents contain contradictory changes:

1. Use specific instructions to establish priorities
2. Consider creating a "differential" document highlighting conflicts
3. Use the reflection capability to review initial merge results

**Example instruction for conflict resolution:**

```
Identify and highlight conflicting sections between the base and edited documents.
For mathematical expressions, maintain the base file versions but note contradictions.
For textual descriptions, prefer the edited file's versions when they provide more detail.
```

## LaTeX-Specific Merge Features

CoAuthor's merge functionality is specifically optimized for LaTeX documents:

### LaTeX Structure Preservation

The intelligent merge preserves important LaTeX structural elements:

- Document class and preamble
- Section and subsection hierarchy
- Environments (figures, tables, equations)
- Label and reference relationships
- Bibliography and citation structure

### Math Expression Handling

Mathematical expressions require special care during merges:

1. Equations are preserved structurally
2. Notation consistency is maintained
3. Alignment environments are handled properly
4. Displayed vs. inline math distinction is preserved

### Bibliography Management

For documents with citations:

1. Citations from both documents are preserved
2. Bibliography entries are combined
3. Citation styles are made consistent
4. BibTeX/BibLaTeX compatibility is maintained

## Visualizing Merge Results

CoAuthor provides several ways to visualize merge results:

### LaTeX Diff View

After a merge, you can view a diff highlighting changes:

1. In the LaTeXdiffs section, select the base file and merged file
2. Click the "latexdiff" button
3. Review the generated diff document

<!-- ![LaTeX Diff View](/images/latex-diff-view.png) -->

### Merge Log Analysis

The ProgressBoard shows detailed merge analysis:

1. Identify the sections that were changed
2. See the reasoning behind merge decisions
3. Find potential issues or conflicts

## Best Practices

### Preparing Documents for Merging

For best merge results:

1. **Consistent Formatting**: Ensure both documents use similar LaTeX formatting
2. **Clean Documents**: Remove comments and unnecessary code
3. **Run latexindent**: Format both documents for consistent indentation
4. **Validate Documents**: Ensure both documents compile without errors

### Effective Merge Instructions

Write clear merge instructions:

1. **Establish Priorities**: Clearly state which document takes precedence for what aspects
2. **Identify Key Sections**: Specify handling for important document sections
3. **Define Terminology**: Note preferred terminology and notation
4. **Specify Style Preferences**: Indicate preferred writing style and formatting

### Post-Merge Validation

After merging:

1. **Compile the Document**: Ensure the merged document compiles without errors
2. **Check References**: Verify all cross-references and citations work
3. **Review Figures and Tables**: Ensure all figures and tables are properly incorporated
4. **Validate Equations**: Check all mathematical expressions for correctness

## Common Merge Scenarios

### Incorporating Reviewer Feedback

When merging reviewer suggestions:

```
Merge the edited file (containing reviewer changes) with priority on:
1. Implementing all requested clarifications and expansions
2. Correcting identified errors
3. Preserving the original structure and flow
4. Maintaining consistent terminology
```

### Combining Author Contributions

When merging contributions from collaborators:

```
Merge the base document with co-author contributions by:
1. Adding new content from sections 3-5 of the edited file
2. Preserving the mathematical notation from the base file
3. Integrating additional references from the edited file
4. Maintaining the writing style of the base document
```

### Updating Derived Documents

When updating a document derived from a main version:

```
Integrate changes from the base document (main version) into the edited document (derived version) by:
1. Updating all shared sections to match the base document
2. Preserving unique content in the edited document
3. Ensuring notation consistency throughout
4. Updating references to match the base document
```

## Troubleshooting

### Merge Failures

If a merge operation fails:

1. Check the ProgressBoard for specific error messages
2. Verify both input documents compile successfully
3. Try merging smaller sections of the document
4. Use a more powerful model (e.g., upgrade from Sonnet to Opus)

### Inconsistent Results

For inconsistent merge results:

1. Use more specific instructions
2. Enable reflection to allow the model to review its merge
3. Verify both documents use compatible LaTeX styles
4. Pre-process documents to resolve major formatting differences

### Lost Content

If important content is lost during merging:

1. Be more explicit about content preservation in instructions
2. Use "preserve content from both documents" instruction
3. Process the documents in smaller chunks
4. Manually identify and add missing content

## Next Steps

Now that you understand CoAuthor's intelligent merge feature, you might want to explore:

- [LaTeX Diff](/guide/latex-diff) - Learn more about comparing document versions
- [File Management](/guide/file-management) - Understand how to organize files for efficient workflows
- [Custom Agents](/guide/custom-agents) - Create specialized agents for your merge scenarios
