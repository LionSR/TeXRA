import React from 'react';
import { FileText, Settings, Braces, FileCode, Files, Link, Box } from 'lucide-react';

const YamlSection = ({ children }) => (
  <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4 mb-4">
    {children}
  </div>
);

const YamlField = ({ name, value, required = false, description }) => (
  <div className="mb-3">
    <div className="flex items-start gap-2">
      <code className="text-purple-600 font-mono">{name}:</code>
      <code className="text-blue-600 font-mono">{value}</code>
      {required && (
        <span className="text-xs px-2 py-0.5 bg-red-100 text-red-600 rounded">Required</span>
      )}
    </div>
    {description && (
      <p className="text-sm text-gray-600 mt-1 ml-4">{description}</p>
    )}
  </div>
);

const ExampleBlock = ({ title, children }) => (
  <div className="mt-2 ml-4">
    <div className="text-sm font-medium text-gray-500 mb-1">{title}</div>
    <div className="bg-gray-50 p-3 rounded font-mono text-sm whitespace-pre">{children}</div>
  </div>
);

const Mapping = ({ from, to }) => (
  <div className="flex items-center gap-2 text-sm mb-2">
    <code className="bg-blue-50 px-2 py-0.5 rounded">{from}</code>
    <div className="text-gray-400">→</div>
    <code className="bg-green-50 px-2 py-0.5 rounded">{to}</code>
  </div>
);

export default function YamlStructureVisualization() {
  return (
    <div className="max-w-5xl mx-auto p-6 bg-gray-50">
      <h2 className="text-2xl font-bold mb-6">CoAuthor YAML Configuration Structure</h2>
      
      {/* Core Settings Section */}
      <YamlSection>
        <div className="flex items-center gap-2 mb-4">
          <Settings className="w-5 h-5 text-blue-600" />
          <h3 className="font-semibold">Core Settings</h3>
        </div>
        
        <YamlField 
          name="agent_type" 
          value="direct | think"
          required={true}
          description="Determines processing approach - 'direct' for immediate output, 'think' for scratchpad-based processing"
        />
        
        <YamlField 
          name="document_tag" 
          value="latex_document | latex_documents | rebuttal_package"
          required={true}
          description="XML wrapper tag for output content - 'latex_documents' for multiple files"
        />
        
        <YamlField 
          name="end_tag" 
          value="</latex_document> | \end{document}"
          required={true}
          description="Marker indicating document completion"
        />
        
        <ExampleBlock title="Example">
{`settings:
  agent_type: direct
  document_tag: latex_document
  end_tag: </latex_document>
  output_ext: tex
  prefills:
    - "Here is the revised LaTeX document: <latex_document>"`}
        </ExampleBlock>
      </YamlSection>

      {/* File Mapping Section */}
      <YamlSection>
        <div className="flex items-center gap-2 mb-4">
          <Files className="w-5 h-5 text-green-600" />
          <h3 className="font-semibold">File Mapping & Patterns</h3>
        </div>

        <div className="grid grid-cols-2 gap-6">
          <div>
            <h4 className="font-medium mb-2">Required Files Pattern</h4>
            <YamlField 
              name="required_files"
              value="Dict[str, str]"
              description="Map variable names to external file paths"
            />
            <Mapping from="COMMANDS" to="path/to/commands.tex" />
            <Mapping from="TEMPLATE" to="path/to/template.tex" />
          </div>

          <div>
            <h4 className="font-medium mb-2">Internal Required Files</h4>
            <YamlField 
              name="required_files_internal"
              value="Dict[str, str]"
              description="Map variable names to files within agent directory"
            />
            <Mapping from="STYLE" to="style.tex" />
            <Mapping from="MACROS" to="macros.tex" />
          </div>
        </div>

        <div className="mt-4">
          <h4 className="font-medium mb-2">File Pattern Matching</h4>
          <YamlField 
            name="file_patterns_contain"
            value="List[Dict[str, str]]"
            description="Define patterns to match file types and assign variables"
          />
          
          <ExampleBlock title="Pattern Configuration">
{`file_patterns_contain:
  - pattern: "command"
    var_name: "COMMANDS"
    categories: ["auxiliary_file", "auxiliary_files"]
  - pattern: "template"
    var_name: "TEMPLATE" 
    categories: ["reference_file", "reference_files"]`}
          </ExampleBlock>
        </div>
      </YamlSection>

      {/* Variable Substitution Section */}
      <YamlSection>
        <div className="flex items-center gap-2 mb-4">
          <Braces className="w-5 h-5 text-orange-600" />
          <h3 className="font-semibold">Variable Substitution</h3>
        </div>

        <div className="grid grid-cols-2 gap-6">
          <div>
            <h4 className="font-medium mb-2">Input Files</h4>
            <YamlField name="INPUT_FILE" value="Primary input file path" />
            <YamlField name="INPUT_CONTENT" value="Content of primary input" />
            <YamlField name="ADDITIONAL_INPUTS" value="XML format of additional inputs" />
          </div>

          <div>
            <h4 className="font-medium mb-2">Support Files</h4>
            <YamlField name="AUXILIARY_FILES" value="XML format of aux files" />
            <YamlField name="REFERENCE_FILES" value="XML format of reference files" />
            <YamlField name="ALL_INPUTS" value="Combined input files list" />
          </div>
        </div>

        <ExampleBlock title="Variable Usage in Prompts">
{`user_prefix: |
  Here is the LaTeX document with auxiliary files:
  <documents>
  {{ AUXILIARY_FILES }}
  <document name="{{ INPUT_FILE }}">
  {{ INPUT_CONTENT }}
  </document>
  </documents>`}
        </ExampleBlock>
      </YamlSection>

      {/* Optional Fields Section */}
      <YamlSection>
        <div className="flex items-center gap-2 mb-4">
          <Box className="w-5 h-5 text-purple-600" />
          <h3 className="font-semibold">Optional Configuration</h3>
        </div>

        <div className="grid grid-cols-2 gap-6">
          <div>
            <YamlField 
              name="output_ext" 
              value="tex | txt | md"
              description="Output file extension (default: tex)"
            />
            <YamlField 
              name="prefills" 
              value="List[str]"
              description="Initial content for output generations"
            />
            <YamlField 
              name="default_output_files" 
              value="List[str]"
              description="Default files when no output_files specified"
            />
          </div>

          <div>
            <YamlField 
              name="instruction" 
              value="Optional[str]"
              description="Custom processing instructions"
            />
            <ExampleBlock title="Example with Instructions">
{`instruction: |
  Focus on improving:
  1. Equation formatting
  2. Figure captions
  3. Citation style`}
            </ExampleBlock>
          </div>
        </div>
      </YamlSection>
    </div>
  );
}
