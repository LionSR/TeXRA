<script setup>
import MultiOutputMatchHero from '../.vitepress/components/MultiOutputMatchHero.vue'
import MultiInputOrderHero from '../.vitepress/components/MultiInputOrderHero.vue'
import CliRunHero from '../.vitepress/components/CliRunHero.vue'
</script>

# Handling multiple files (inputs & outputs)

When a paper is split across several files (`chapter1.tex`, `chapter2.tex`, `appendixA.tex`), a single program run can read them together and write one revised file per input.

## UI for multiple files

Name the files in your request ("polish chapter1.tex and chapter2.tex together"), and the agent lists them on the program run it proposes. To change the list, select **Edit** on the proposal card.

- **Input Files**: The Input group is an ordered list. Use **Add input files** (<wa-icon library="texra" name="add"></wa-icon>), **Add opened files as input** (<wa-icon library="texra" name="folder-opened"></wa-icon>), or drag-and-drop to append sources. They are provided together to the program. For programs that edit, the expected output filenames are the selected input filenames in the same order.
- **Fixed Outputs**: `transcribe`, `slides` and `poster` write one new document with a fixed name (`transcript.tex`, `slides.tex`, `poster.tex`), whatever the inputs are called.

<MultiInputOrderHero />

<p class="hero-caption">The Input group is an ordered list; drag to reorder. For programs that edit, the row order is the output order, and each input filename is reused as its output filename.</p>

Multi-file runs are not webview-only. In the terminal, repeated `--input`
flags are the same ordered Input list, and `--output-dir` collects the
per-file artifacts:

<CliRunHero
  command="texra run edit --input chapter1.tex --input chapter2.tex --instruction 'Polish the prose' --output-dir polished"
  :rounds="[
    { label: 'Revision 1: draft', state: 'done' },
    { label: 'Revision 2: review and correct', state: 'done' },
  ]"
  :outputs="['…/polished/chapter1.tex', '…/polished/chapter2.tex']"
  note="One full copied path per output: relative document paths are preserved under the directory."
/>

_(Read the [file management guide](./file-management.md) for general UI controls.)_

## How it works: input

When you provide multiple input files, TeXRA combines their content, each under its filename, and includes it in the prompt of every revision. The model sees all the documents together.

## How it works: output & extraction

This is the part that matters for generating multiple distinct files:

1. **TeXRA determines outputs:** Programs that edit use the selected input filenames as the output filenames. Programs that create a document use their fixed filename.
2. **The model replies with structured XML:** TeXRA ends every request with the reply format, so the model produces a _single XML response_ containing a separate block for each expected output file:

   ```xml
   <documents>  <!-- fixed protocol container, not agent-configurable -->
     <document name="chapter2.tex">
       % ... content for the first output file ...
     </document>
     <document name="appendixA.tex">
       % ... content for the second output file ...
     </document>
     ...
   </documents>
   ```

3. **TeXRA extracts:** TeXRA reads each `<document>` block of the reply and saves its content in the revision folder under the block's `name`.
4. **Missing files are reported:** If the reply has no `<document>` block named for an expected output filename, that file is not written for the revision and the run reports it as missing. With `--output-dir`, the command copies the files it has and then fails, naming the missing ones. A block with a name nobody expected is saved under that name as well.

<MultiOutputMatchHero />

<p class="hero-caption">Each <code>&lt;document name="…"&gt;</code> block is saved under its name and checked against the expected output filenames. An expected file with no block is reported as missing; a block with an unexpected name is saved as an extra file.</p>

## Next steps

- [The assistant and programs](./programs.md#document-programs): the programs and what each writes.
- [File management](./file-management.md): the file selection UI in detail.
- [Programs: how they work](./agent-architecture.md): how a program's revisions run.
