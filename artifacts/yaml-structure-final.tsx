import React from "react";
import {
  FileText,
  Settings,
  Braces,
  Files,
  ArrowRight,
  Box,
  Terminal,
  MessageSquare,
  ArrowDown,
  FileCode,
} from "lucide-react";

const YamlSection = ({ children }) => (
  <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4 mb-4">
    {children}
  </div>
);

const CoreInput = ({ name, description }) => (
  <div className="flex items-center gap-2 p-2 bg-blue-50 rounded mb-2">
    <div className="font-medium text-blue-700">{name}</div>
    <div className="text-sm text-blue-600">→</div>
    <div className="text-sm text-blue-800">{description}</div>
  </div>
);

const FileInput = ({ name, description }) => (
  <div className="flex items-center gap-2 p-2 bg-green-50 rounded mb-2">
    <div className="font-medium text-green-700">{name}</div>
    <div className="text-sm text-green-600">→</div>
    <div className="text-sm text-green-800">{description}</div>
  </div>
);

const YamlField = ({ name, value, required = false, description }) => (
  <div className="mb-3">
    <div className="flex items-start gap-2">
      <code className="text-purple-600 font-mono">{name}:</code>
      <code className="text-blue-600 font-mono">{value}</code>
      {required && (
        <span className="text-xs px-2 py-0.5 bg-red-100 text-red-600 rounded">
          Required
        </span>
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
    <div className="bg-gray-50 p-3 rounded font-mono text-sm whitespace-pre overflow-x-auto">
      {children}
    </div>
  </div>
);

const FileMapping = ({ title, example }) => (
  <div className="mb-4">
    <h4 className="font-medium mb-2">{title}</h4>
    <ExampleBlock title="Raw File">{example.raw}</ExampleBlock>
    <div className="flex items-center justify-center my-2">
      <ArrowDown className="w-4 h-4 text-gray-400" />
    </div>
    <ExampleBlock title="XML Wrapped">{example.wrapped}</ExampleBlock>
  </div>
);

const PromptFlowBox = ({ title, content, color = "bg-white" }) => (
  <div className={`p-4 rounded-lg shadow-sm border border-gray-200 ${color}`}>
    <div className="font-medium mb-2">{title}</div>
    <div className="text-sm text-gray-600 space-y-1">{content}</div>
  </div>
);

const PromptFlow = () => (
  <div className="flex flex-col items-center gap-4">
    <div className="grid grid-cols-3 gap-8 w-full">
      <PromptFlowBox
        title="System Context"
        content={
          <div className="bg-blue-50 p-2 rounded">
            <code>systemPrompt</code>
            <div className="text-xs mt-1">Sets behavior and requirements</div>
            <div className="text-xs italic mt-1">
              e.g., LaTeX formatting rules
            </div>
          </div>
        }
      />
      <PromptFlowBox
        title="Document Loading"
        content={
          <div className="bg-green-50 p-2 rounded">
            <code>userPrefix</code>
            <div className="text-xs mt-1">Loads and structures input files</div>
            <div className="text-xs italic mt-1">
              e.g., XML document wrapping
            </div>
          </div>
        }
      />
      <PromptFlowBox
        title="Task Specification"
        content={
          <div className="bg-yellow-50 p-2 rounded">
            <code>userRequest</code>
            <div className="text-xs mt-1">Defines specific tasks</div>
            <div className="text-xs italic mt-1">
              e.g., Revision instructions
            </div>
          </div>
        }
      />
    </div>
    <ArrowDown className="w-6 h-6 text-blue-500" />
    <div className="grid grid-cols-2 gap-8 w-full">
      <PromptFlowBox
        title="Assistant Start"
        content={
          <div className="bg-purple-50 p-2 rounded">
            <code>prefills[round]</code>
            <div className="text-xs mt-1">Initial structure and tags</div>
            <div className="text-xs italic mt-1">e.g., &lt;scratchpad&gt;</div>
          </div>
        }
      />
      <PromptFlowBox
        title="Structured Output"
        content={
          <div className="bg-orange-50 p-2 rounded">
            <code>&lt;documentTag&gt;...&lt;/documentTag&gt;</code>
            <div className="text-xs mt-1">Final formatted content</div>
            <div className="text-xs italic mt-1">
              e.g., &lt;latex_document&gt;
            </div>
          </div>
        }
      />
    </div>
  </div>
);

export default function YamlStructureVisualization() {
  return (
    <div className="max-w-5xl mx-auto p-6 bg-gray-50">
      <h2 className="text-2xl font-bold mb-6">
        CoAuthor YAML Configuration Structure
      </h2>

      {/* Frontend Inputs */}
      <YamlSection>
        <div className="flex items-center gap-2 mb-4">
          <Terminal className="w-5 h-5 text-green-600" />
          <h3 className="font-semibold">Frontend Inputs</h3>
        </div>

        <div>
          <h4 className="font-medium mb-2">Core Parameters</h4>
          <CoreInput name="agent" description="Selected agent type" />
          <CoreInput name="model" description="AI model to use" />
          <CoreInput name="instruction" description="Processing instructions" />
          <CoreInput name="reflect" description="Enable reflection phase" />
        </div>

        <div className="mt-4">
          <h4 className="font-medium mb-2">File Inputs</h4>
          <FileInput
            name="inputFile/inputFiles"
            description="Main content file(s)"
          />
          <FileInput
            name="referenceFile/referenceFiles"
            description="Reference materials"
          />
          <FileInput
            name="auxiliaryFile/auxiliaryFiles"
            description="Support files"
          />
        </div>
      </YamlSection>

      {/* Core Settings */}
      <YamlSection>
        <div className="flex items-center gap-2 mb-4">
          <Settings className="w-5 h-5 text-purple-600" />
          <h3 className="font-semibold">Core Settings</h3>
        </div>

        <YamlField
          name="agentType"
          value="direct | CoT"
          required={true}
          description="Processing approach - 'direct' for immediate output, 'CoT' for scratchpad-based"
        />

        <YamlField
          name="documentTag"
          value="latex_document | rebuttal_package"
          required={true}
          description="XML wrapper for output content"
        />

        <YamlField
          name="endTag"
          value="</latex_document> | </rebuttal_package>"
          required={true}
          description="Matching end tag"
        />

        <YamlField
          name="prefills"
          value="List[str]"
          description="Initial content structure for each round"
        />

        <ExampleBlock title="Example">
          {`settings:
  agentType: direct
  documentTag: rebuttal_package
  endTag: </rebuttal_package>
  outputExt: xml
  prefills: 
    - <rebuttal_package>\\n<scratchpad>`}
        </ExampleBlock>
      </YamlSection>

      {/* File Configuration */}
      <YamlSection>
        <div className="flex items-center gap-2 mb-4">
          <FileCode className="w-5 h-5 text-blue-600" />
          <h3 className="font-semibold">File Configuration</h3>
        </div>

        <div className="grid grid-cols-2 gap-6">
          <div>
            <FileMapping
              title="Required Files"
              example={{
                raw: "COMMANDS: path/to/commands.tex",
                wrapped:
                  '<document name="commands.tex">\n  \\newcommand{\\op}{\\hat{O}}\n</document>',
              }}
            />
          </div>

          <div>
            <FileMapping
              title="Pattern Matched Files"
              example={{
                raw: 'pattern: "main"\nvarName: "MAIN"\ncategories: ["inputFile"]',
                wrapped:
                  '<document name="paper.tex">\n  \\documentclass{article}\n  % Main paper content\n</document>',
              }}
            />
          </div>
        </div>

        <ExampleBlock title="Combined Documents Structure">
          {`<documents>
  {{ AUXILIARY_FILES }}
  <document name="{{ INPUT_FILE }}">
    {{ INPUT_CONTENT }}
  </document>
  {{ ADDITIONAL_INPUTS }}
</documents>`}
        </ExampleBlock>
      </YamlSection>

      {/* Prompt Flow */}
      <YamlSection>
        <div className="flex items-center gap-2 mb-4">
          <MessageSquare className="w-5 h-5 text-orange-600" />
          <h3 className="font-semibold">Prompt Construction Flow</h3>
        </div>
        <PromptFlow />
      </YamlSection>
    </div>
  );
}
