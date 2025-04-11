# AI Agents

TeXRA provides a variety of specialized AI agents designed to assist with different aspects of academic research. Each agent has been optimized for specific tasks through careful prompt engineering and tool integration.

## Core Agents

### correct

The `correct` agent focuses on fixing errors without changing the style or content of your document.

**Purpose:** Fix typos, grammatical errors, and LaTeX syntax issues.

**Best for:**

- Final proofreading before submission
- Fixing errors in collaborative documents
- Ensuring consistent formatting and notation

**Example instruction:**

```
Fix grammatical errors, typos, and LaTeX syntax issues throughout the document.
Ensure consistent notation for mathematical symbols and equations.
Don't change the technical content or writing style.
```

**Sample output:**

```diff
- The experment was conducted over a perid of three monthes.
+ The experiment was conducted over a period of three months.

- We define the function $f(x) = x^2 + 2x + 1$ which can be factorised.
+ We define the function $f(x) = x^2 + 2x + 1$ which can be factorized.

- The results are summarized in table \ref{tab:results}.
+ The results are summarized in Table \ref{tab:results}.
```

### polish

The `polish` agent enhances the writing style and clarity of your document while preserving technical content.

**Purpose:** Improve readability, flow, and overall writing quality.

**Best for:**

- Enhancing draft manuscripts
- Making technical content more accessible
- Improving the flow between sections

**Example instruction:**

```
Improve the clarity and readability of this document. Make the language more concise
and enhance the flow between paragraphs. Maintain all technical content and equations.
Focus especially on the introduction and discussion sections.
```

**Sample output:**

```diff
- In this paper we will show a new method for analyzing the data. The method is based on
- statistical analysis. It can be used for different types of experiments.
+ In this paper, we present a novel method for data analysis based on statistical principles.
+ This approach can be applied across various experimental designs, offering flexibility and robustness.

- The implications of our findings are significant and important because they suggest
- that the theory we proposed earlier is correct.
+ Our findings have significant implications, providing strong support for our previously
+ proposed theoretical framework.
```

### draw

The `draw` agent creates or enhances TikZ figures based on textual descriptions or existing figures.

**Purpose:** Generate visual representations of concepts, systems, or data.

**Best for:**

- Creating diagrams, flowcharts, or schematics
- Improving existing figures
- Converting descriptions into visualizations

**Example instruction:**

```
Create a TikZ figure illustrating a neural network with an input layer (3 nodes),
two hidden layers (5 nodes each), and an output layer (2 nodes).
Use appropriate colors and add labels for each layer.
```

**Sample output:**

```latex
\begin{tikzpicture}[shorten >=1pt, ->, draw=black!50, node distance=\layersep]
    \tikzstyle{neuron}=[circle, fill=gray!25, minimum size=17pt, inner sep=0pt]
    \tikzstyle{input neuron}=[neuron, fill=green!50];
    \tikzstyle{hidden neuron}=[neuron, fill=blue!50];
    \tikzstyle{output neuron}=[neuron, fill=red!50];
    \tikzstyle{annot} = [text width=4em, text centered]

    % Define layer separation
    \def\layersep{2.5cm}

    % Input layer
    \foreach \i in {1,...,3} {
        \node[input neuron] (I-\i) at (0,-\i) {};
    }

    % Hidden layer 1
    \foreach \i in {1,...,5} {
        \node[hidden neuron] (H1-\i) at (\layersep,-\i*0.8+0.8) {};
    }

    % Hidden layer 2
    \foreach \i in {1,...,5} {
        \node[hidden neuron] (H2-\i) at (2*\layersep,-\i*0.8+0.8) {};
    }

    % Output layer
    \foreach \i in {1,...,2} {
        \node[output neuron] (O-\i) at (3*\layersep,-\i*1.5+0.75) {};
    }

    % Connect the layers
    \foreach \i in {1,...,3} {
        \foreach \j in {1,...,5} {
            \draw (I-\i) -- (H1-\j);
        }
    }

    \foreach \i in {1,...,5} {
        \foreach \j in {1,...,5} {
            \draw (H1-\i) -- (H2-\j);
        }
    }

    \foreach \i in {1,...,5} {
        \foreach \j in {1,...,2} {
            \draw (H2-\i) -- (O-\j);
        }
    }

    % Layer labels
    \node[annot, above of=I-1, node distance=1cm] (il) {Input layer};
    \node[annot, above of=H1-1, node distance=1cm] (hl1) {Hidden layer 1};
    \node[annot, above of=H2-1, node distance=1cm] (hl2) {Hidden layer 2};
    \node[annot, above of=O-1, node distance=1cm] (ol) {Output layer};
\end{tikzpicture}
```

## Transformation Agents

### paper2note

The `paper2note` agent transforms research papers into comprehensive lecture notes.

**Purpose:** Convert academic papers to educational materials.

**Best for:**

- Creating teaching materials from research papers
- Converting dense research into student-friendly content
- Developing study guides for complex topics

**Example instruction:**

```
Transform this research paper into lecture notes suitable for a graduate-level course.
Add explanatory text for complex concepts, include discussion questions, and highlight
key takeaways. Create sections for Introduction, Background, Methods, Results, and Discussion.
```

### paper2slide

The `paper2slide` agent converts research papers into LaTeX beamer presentations.

**Purpose:** Create presentation slides from academic content.

**Best for:**

- Preparing conference presentations
- Converting papers for teaching purposes
- Creating seminar materials

**Example instruction:**

```
Convert this paper into a beamer presentation with approximately 15-20 slides.
Include a title slide, outline, introduction, methodology, results, and conclusion.
Use bullet points for clarity and add slide titles. Include the key figures and tables.
```

### paper2poster

The `paper2poster` agent transforms papers into academic conference posters.

**Purpose:** Create well-structured academic posters.

**Best for:**

- Conference poster preparation
- Visual research summaries
- Academic showcases

**Example instruction:**

```
Convert this paper into an academic poster using the baposter template.
Include sections for Introduction, Methodology, Results, and Conclusions.
Highlight key figures and tables. Make it visually appealing with appropriate columns.
```

## Specialized Agents

### merge

The `merge` agent intelligently combines changes from multiple documents.

**Purpose:** Integrate edits from different versions or authors.

**Best for:**

- Collaborative writing projects
- Incorporating reviewer suggestions
- Combining different drafts

**Example instruction:**

```
Merge changes from the edited file into the original document. Prioritize substantive
improvements in clarity while maintaining the original's technical precision.
Preserve mathematical notation and citations from the original.
```

### txt2tex

The `txt2tex` agent converts plain text to properly formatted LaTeX.

**Purpose:** Transform unformatted text into LaTeX documents.

**Best for:**

- Converting notes to LaTeX
- Transforming plain text drafts
- Formatting text from other sources

**Example instruction:**

```
Convert this plain text into a properly formatted LaTeX document. Use appropriate
sectioning commands, format equations, and create proper citations. Use the article
class and include necessary packages.
```

## Using Multiple Agents

For complex projects, you may want to apply multiple agents in sequence. Here are some effective workflows:

### Draft to Publication

1. **txt2tex**: Convert initial draft to LaTeX
2. **polish**: Improve the writing style
3. **correct**: Final proofreading
4. **draw**: Add or enhance figures

### Paper to Teaching Materials

1. **paper2note**: Convert paper to lecture notes
2. **paper2slide**: Create presentation slides
3. **polish**: Enhance clarity for students
4. **draw**: Add explanatory figures

## Customizing Agent Behavior

You can customize agent behavior through:

1. **Specific Instructions**: Provide detailed guidance in the instruction field
2. **Tool Configuration**: Enable options like "Reflect" for self-improvement
3. **Model Selection**: Choose different models based on task complexity

::: tip
Use the "Reflect" option with agents like `polish` and `draw` to get higher quality results. The AI will review and improve its initial output.
:::

## Creating Custom Agents

Advanced users can create custom agents:

1. Navigate to the agents directory
2. Create a new YAML configuration file
3. Define prompts, settings, and inheritance relationships
4. Restart VS Code to load the new agent

See [Custom Agents](/guide/custom-agents) for detailed instructions.

## Next Steps

Now that you understand the different agents available in TeXRA, you might want to explore:

- [Models](/guide/models) - Learn about the different AI models and their capabilities
- [File Management](/guide/file-management) - Understand how to work with multiple files
- [Tool Integration](/guide/tool-integration) - Discover how TeXRA integrates with external tools
