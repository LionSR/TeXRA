import React, { useState } from "react";
import {
  FileText,
  ChevronDown,
  ArrowRight,
  RefreshCcw,
  FileCode,
  Scroll,
  PenTool,
  ChevronRight,
  Layers,
  MessageSquare,
  Workflow,
  RotateCw,
  Settings,
  ArrowDownCircle,
  RotateCcw,
} from "lucide-react";

// Sample XML output structure
const SAMPLE_XML_OUTPUT = `<rebuttal_package>
  <scratchpad>
  1. Add data analysis details in Sec II
  2. Revise Fig. 3 caption
  3. Address referee B's concern about methodology
  </scratchpad>
  
  <document name="replies/reply_to_editor_prb.tex">
    \\documentclass{article}
    Dear Dr. Smith,
    
    We thank the referees for their detailed feedback...
  </document>
  
  <document name="replies/reply_to_referees_prb.tex">
    \\begin{referee}{A}
    The analysis lacks statistical significance...
    \\end{referee}
    
    \\begin{response}
    We have added confidence intervals...
    \\end{response}
  </document>
</rebuttal_package>`;

// File Extraction Process Component
const FileExtractionProcess = () => (
  <div className="bg-gray-50 p-4 rounded-lg mt-4 text-sm">
    <h4 className="font-medium mb-2">File Extraction Process:</h4>
    <ol className="space-y-2 text-gray-700">
      <li>
        1. Parse XML structure and extract individual{" "}
        <code>&lt;document&gt;</code> nodes
      </li>
      <li>2. Write content to separate files based on name attribute</li>
      <li>
        3. Generate diff files comparing with original versions:
        <div className="pl-4 mt-1 font-mono text-xs">
          latexdiff original/paper.tex extracted/paper.tex -o paper_diff.tex
        </div>
      </li>
      <li>
        4. Apply template formatting from template files:
        <div className="pl-4 mt-1 font-mono text-xs">
          template_reply_to_editor.tex → reply_to_editor_prb.tex
        </div>
      </li>
    </ol>
  </div>
);

const ProcessingStages = () => (
  <div className="relative py-12 px-4">
    <div className="flex justify-between items-center px-12">
      {[
        {
          label: "Document Ingestion",
          icon: FileText,
          tooltip: "Load and validate all input files",
        },
        {
          label: "XML Wrapping",
          icon: FileCode,
          tooltip: "Structure content with XML tags",
        },
        {
          label: "Template Processing",
          icon: Workflow,
          tooltip: "Apply document templates and rules",
        },
        {
          label: "File Generation",
          icon: Layers,
          tooltip: "Create and verify all outputs",
        },
      ].map((stage, idx, arr) => (
        <div key={idx} className="relative group">
          {/* Main stage box */}
          <div className="flex flex-col items-center gap-2 bg-white p-4 rounded-lg shadow-sm border border-gray-200">
            <stage.icon className="w-6 h-6 text-blue-600" />
            <span className="text-sm font-medium whitespace-nowrap">
              {stage.label}
            </span>
          </div>

          {/* Tooltip */}
          <div className="absolute -top-8 left-1/2 -translate-x-1/2 opacity-0 group-hover:opacity-100 transition-opacity z-10">
            <div className="bg-gray-800 text-white text-xs rounded px-2 py-1 whitespace-nowrap">
              {stage.tooltip}
            </div>
          </div>

          {/* Connector line */}
          {idx < arr.length - 1 && (
            <div className="absolute top-1/2 -translate-y-1/2 left-[95%] w-[calc(100%-10px)] h-[2px] bg-blue-200" />
          )}
        </div>
      ))}
    </div>

    {/* Reflection Loop */}
    <div className="absolute w-[90%] h-[70px] border-2 border-purple-300 rounded-full left-1/2 -translate-x-1/2 -bottom-4 border-b-0">
      {/* Reflection label */}
      <div className="absolute left-1/2 -translate-x-1/2 -top-3 bg-white px-3 py-1 text-purple-600 text-sm font-medium flex items-center gap-2 rounded-full border border-purple-200">
        <RotateCcw className="w-4 h-4" />
        Reflection Loop
      </div>
      {/* Arrows */}
      <ArrowRight className="w-5 h-5 text-purple-400 absolute right-0 top-0 -translate-y-1/2" />
      <ArrowRight className="w-5 h-5 text-purple-400 absolute left-0 top-0 -translate-y-1/2 rotate-180" />
    </div>
  </div>
);

// Prompt Preview Component
const PromptPreview = ({ expanded, onToggle }) => (
  <div className="bg-white p-4 rounded-lg shadow">
    <div className="flex items-center gap-2 cursor-pointer" onClick={onToggle}>
      <MessageSquare className="w-5 h-5 text-blue-600" />
      <h3 className="font-medium">Agent Prompt Structure</h3>
      <ChevronRight
        className={`w-4 h-4 transition-transform ${expanded ? "rotate-90" : ""}`}
      />
    </div>
    {expanded && (
      <div className="mt-3 pl-4 text-sm space-y-2 border-l-2 border-blue-200">
        <div className="space-y-1">
          <div className="font-medium text-blue-800">systemPrompt:</div>
          <div className="pl-3 text-gray-600">
            Configure agent behavior for rebuttal package processing:
            <ul className="list-disc pl-4 mt-1">
              <li>Maintain LaTeX conventions</li>
              <li>Process multiple document types</li>
              <li>Handle referee comments and responses</li>
            </ul>
          </div>
        </div>
        <div className="space-y-1">
          <div className="font-medium text-blue-800">userPrefix:</div>
          <div className="pl-3 text-gray-600">
            Load documents with XML structure:
            <div className="font-mono text-xs mt-1 bg-gray-100 p-1 rounded">
              {"<documents>"}
              <br />
              {'  <document name="paper.tex">...'}
            </div>
          </div>
        </div>
        <div className="space-y-1">
          <div className="font-medium text-blue-800">userRequest:</div>
          <div className="pl-3 text-gray-600">
            Process rebuttal package with focus on:
            <ul className="list-disc pl-4 mt-1">
              <li>Response coherence</li>
              <li>Content accuracy</li>
              <li>LaTeX formatting</li>
            </ul>
          </div>
        </div>
      </div>
    )}
  </div>
);

// File Selection Actions Component
const FileActions = ({ onRefresh, onCurrent }) => (
  <div className="flex gap-2">
    <button
      className="p-1 hover:bg-gray-100 rounded"
      title="Refresh Files"
      onClick={onRefresh}
    >
      <RefreshCcw className="w-4 h-4" />
    </button>
    <button
      className="p-1 hover:bg-gray-100 rounded"
      title="Current File"
      onClick={onCurrent}
    >
      <FileCode className="w-4 h-4" />
    </button>
  </div>
);

// Main Component
export default function RebuttalWorkflowComplete() {
  const [promptExpanded, setPromptExpanded] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState([
    "replies/reply_to_referees_prb.tex",
    "replies/reply_to_editor_prb.tex",
    "replies/list_of_major_changes_prb.tex",
    "RenyiNetPaper.tex",
    "supp.tex",
  ]);

  return (
    <div className="w-full max-w-7xl mx-auto p-6 space-y-6">
      <h2 className="text-2xl font-bold text-gray-800 text-center mb-8">
        MultiFile Processing Agents
      </h2>

      {/* Top Controls */}
      <div className="grid grid-cols-3 gap-4 bg-white p-4 rounded-lg shadow">
        <div className="space-y-2">
          <label className="text-sm font-medium text-gray-700">Agent:</label>
          <select className="w-full p-2 border rounded">
            <option>revise_rebuttal</option>
            <option>polish_rebuttal</option>
          </select>
        </div>
        <div className="space-y-2">
          <label className="text-sm font-medium text-gray-700">Model:</label>
          <select className="w-full p-2 border rounded">
            <option>sonnet3+</option>
            <option>opus</option>
          </select>
        </div>
        <div className="space-y-2">
          <label className="text-sm font-medium text-gray-700">Reflect:</label>
          <select className="w-full p-2 border rounded">
            <option>True</option>
            <option>False</option>
          </select>
        </div>
      </div>

      {/* Prompt Structure */}
      <PromptPreview
        expanded={promptExpanded}
        onToggle={() => setPromptExpanded(!promptExpanded)}
      />

      {/* Main Content Grid */}
      <div className="grid grid-cols-2 gap-6">
        {/* Left Column: File Selection */}
        <div className="space-y-4 bg-white p-4 rounded-lg shadow">
          <div className="file-select-group space-y-4">
            {/* Input Files */}
            <div>
              <div className="flex justify-between items-center mb-2">
                <label className="font-medium flex items-center gap-2">
                  <FileText className="w-4 h-4" />
                  Select Input Files:
                </label>
                <FileActions
                  onRefresh={() => console.log("Refresh")}
                  onCurrent={() => console.log("Current")}
                />
              </div>
              <select className="w-full p-2 border rounded">
                <option>RenyiNetPaper.tex</option>
                <option>RenyiNetSM.tex</option>
                <option>supp.tex</option>
              </select>
              <div className="mt-2 pl-4 text-sm text-gray-600 space-y-1">
                {selectedFiles.slice(0, 3).map((file, i) => (
                  <div key={i}>• {file}</div>
                ))}
              </div>
            </div>

            {/* Multiple Output Files */}
            <div className="border-t pt-4">
              <div className="flex justify-between items-center mb-2">
                <label className="font-medium flex items-center gap-2">
                  <Layers className="w-4 h-4" />
                  Multiple Output Files:
                </label>
              </div>
              <div className="pl-4 text-sm text-gray-600 space-y-1">
                {selectedFiles.map((file, i) => (
                  <div key={i} className="flex items-center justify-between">
                    <span>{file}</span>
                    <button
                      className="text-red-500"
                      onClick={() =>
                        setSelectedFiles((files) =>
                          files.filter((_, index) => index !== i),
                        )
                      }
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Right Column: Instructions & Scratchpad */}
        <div className="space-y-4">
          {/* Instructions Box */}
          <div className="bg-white p-4 rounded-lg shadow">
            <div className="flex items-center gap-2 mb-3">
              <Scroll className="w-5 h-5 text-blue-600" />
              <h3 className="font-medium">Instructions</h3>
            </div>
            <div className="p-3 bg-blue-50 rounded border border-blue-200 text-sm">
              <ul className="list-disc pl-4 space-y-2">
                <li>Add error analysis in Section II</li>
                <li>Update Fig. 3 with confidence intervals</li>
                <li>Address methodology questions</li>
                <li>Incorporate new simulation results</li>
              </ul>
            </div>
          </div>

          {/* Scratchpad Planning */}
          <div className="bg-white p-4 rounded-lg shadow">
            <div className="flex items-center gap-2 mb-3">
              <PenTool className="w-5 h-5 text-purple-600" />
              <h3 className="font-medium">Scratchpad Planning</h3>
            </div>
            <div className="p-3 bg-purple-50 rounded border border-purple-200 text-sm space-y-3">
              <div>
                <h4 className="font-medium mb-1">Editor Letter Updates:</h4>
                <ul className="list-disc pl-4">
                  <li>Highlight statistical analysis</li>
                  <li>Detail methodology improvements</li>
                </ul>
              </div>
              <div>
                <h4 className="font-medium mb-1">Referee Response Updates:</h4>
                <ul className="list-disc pl-4">
                  <li>Add confidence intervals for all measurements</li>
                  <li>Clarify simulation parameters</li>
                </ul>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* XML Output Preview */}
      <div className="bg-white p-4 rounded-lg shadow">
        <div className="flex items-center gap-2 mb-3">
          <FileCode className="w-5 h-5 text-green-600" />
          <h3 className="font-medium">XML Output Structure</h3>
        </div>
        <pre className="p-4 bg-gray-50 rounded border text-sm font-mono overflow-x-auto">
          {SAMPLE_XML_OUTPUT}
        </pre>
        <FileExtractionProcess />
      </div>

      {/* Improved Processing Stages */}
      <ProcessingStages />
    </div>
  );
}
