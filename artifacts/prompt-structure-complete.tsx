import React, { useState } from "react";
import {
  FileText,
  RefreshCcw,
  MessageSquare,
  Settings,
  Send,
  FileOutput,
  ArrowRight,
} from "lucide-react";

const PromptStructureComplete = () => {
  const [activeSection, setActiveSection] = useState("systemPrompt");
  const [selectedFile, setSelectedFile] = useState("paper.tex");
  const [selectedAux, setSelectedAux] = useState("commands.tex");
  const [instruction, setInstruction] = useState(
    "Improve the clarity of Section 2",
  );

  const promptComponents = {
    systemPrompt: {
      title: "System Prompt",
      icon: <Settings className="w-6 h-6 text-blue-600" />,
      description: "Sets core behavior and requirements",
      preview:
        "Expert LaTeX system setting: format rules, spacing requirements, reference handling with \\cref{}, quotes, and commands.tex usage",
      color: "blue",
    },
    userPrefix: {
      title: "User Prefix",
      icon: <MessageSquare className="w-6 h-6 text-green-600" />,
      description: "Loads documents and context",
      preview:
        "Load and process document content: <documents><document name='paper.tex'>{{INPUT_CONTENT}}</document></documents>",
      color: "green",
    },
    userRequest: {
      title: "User Request",
      icon: <Send className="w-6 h-6 text-orange-600" />,
      description: "Specifies task and instructions",
      preview:
        "Task definition with <instruction>{{instruction}}</instruction> followed by <scratchpad> for planning and <latex_document> for output",
      color: "orange",
      output: {
        title: "Initial Edited Document",
        preview: `paper_correct_r0_sonnet++.tex
paper_correct_r0_sonnet++_diff.tex (vs input)
• Shows added/deleted/modified content
• Generated using latexdiff
• PDF preview available`,
      },
    },
    userReflect: {
      title: "Reflection Phase",
      icon: <RefreshCcw className="w-6 h-6 text-purple-600" />,
      description: "Analysis and refinement",
      preview:
        "Critical review with <reflection> analyzing changes and <idea> suggesting improvements, followed by final document output",
      color: "purple",
      output: {
        title: "Final Edited Document",
        preview: `paper_correct_r1_sonnet++.tex
paper_correct_r1_sonnet++_diff.tex (vs r0)
• Shows incremental improvements
• Generated using latexdiff-vc
• Tracks all document versions`,
      },
    },
  };

  return (
    <div className="w-full max-w-6xl mx-auto p-8 bg-white rounded-lg shadow-lg">
      <h2 className="text-2xl font-bold text-gray-800 mb-8 text-center">
        Prompt Structure
      </h2>

      {/* Frontend File Selection UI */}
      <div className="mb-8 grid grid-cols-2 gap-6">
        <div className="p-4 bg-gray-50 rounded-lg border border-gray-200">
          <div className="mb-4">
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Select Input File:
            </label>
            <select
              className="w-full p-2 border border-gray-300 rounded-md bg-white"
              value={selectedFile}
              onChange={(e) => setSelectedFile(e.target.value)}
            >
              <option value="paper.tex">paper.tex</option>
              <option value="draft.tex">draft.tex</option>
            </select>
          </div>
          <div className="mb-4">
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Select Auxiliary File:
            </label>
            <select
              className="w-full p-2 border border-gray-300 rounded-md bg-white"
              value={selectedAux}
              onChange={(e) => setSelectedAux(e.target.value)}
            >
              <option value="commands.tex">commands.tex</option>
              <option value="macros.tex">macros.tex</option>
            </select>
          </div>
        </div>

        <div className="p-4 bg-gray-50 rounded-lg border border-gray-200">
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Specific Instructions:
          </label>
          <textarea
            className="w-full p-2 border border-gray-300 rounded-md bg-white h-32"
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            placeholder="Enter specific instructions..."
          />
        </div>
      </div>

      {/* Prompt Structure Flow with Outputs */}
      <div className="flex flex-col space-y-4">
        {Object.entries(promptComponents).map(([key, component]) => (
          <div key={key} className="flex items-stretch space-x-4">
            {/* Prompt Component */}
            <div
              className={`flex-1 p-4 rounded-lg border-2 transition-all duration-200 cursor-pointer
                ${activeSection === key ? `border-${component.color}-500 bg-${component.color}-50` : "border-gray-200"}
              `}
              onClick={() => setActiveSection(key)}
            >
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center space-x-3">
                  {component.icon}
                  <div>
                    <h3 className="font-semibold text-gray-800">
                      {component.title}
                    </h3>
                    <p className="text-sm text-gray-600">
                      {component.description}
                    </p>
                  </div>
                </div>
              </div>

              {activeSection === key && (
                <div className="mt-4">
                  <div className="bg-white p-4 rounded border border-gray-200">
                    <pre className="text-sm text-gray-800 whitespace-pre-wrap">
                      {component.preview}
                    </pre>
                  </div>
                </div>
              )}
            </div>

            {/* Output if exists */}
            {component.output && (
              <>
                <ArrowRight className="w-6 h-6 text-gray-400 self-center flex-shrink-0" />
                <div className="w-64 p-4 bg-green-50 rounded-lg border border-green-200">
                  <div className="flex items-center space-x-2 mb-2">
                    <FileOutput className="w-5 h-5 text-green-600" />
                    <h4 className="font-medium text-green-800">
                      {component.output.title}
                    </h4>
                  </div>
                  <p className="text-sm text-green-700">
                    {component.output.preview}
                  </p>
                </div>
              </>
            )}
          </div>
        ))}
      </div>

      {/* Quick Process Overview */}
      <div className="mt-8 flex justify-between items-center p-4 bg-gray-50 rounded-lg border border-gray-200">
        <div className="flex items-center space-x-2">
          <FileText className="w-6 h-6 text-gray-400" />
          <ArrowRight className="w-4 h-4 text-gray-400" />
          <Settings className="w-6 h-6 text-blue-600" />
          <ArrowRight className="w-4 h-4 text-gray-400" />
          <MessageSquare className="w-6 h-6 text-green-600" />
          <ArrowRight className="w-4 h-4 text-gray-400" />
          <Send className="w-6 h-6 text-orange-600" />
          <ArrowRight className="w-4 h-4 text-gray-400" />
          <FileOutput className="w-6 h-6 text-green-600" />
          <ArrowRight className="w-4 h-4 text-gray-400" />
          <RefreshCcw className="w-6 h-6 text-purple-600" />
          <ArrowRight className="w-4 h-4 text-gray-400" />
          <FileOutput className="w-6 h-6 text-green-600" />
        </div>
      </div>
    </div>
  );
};

export default PromptStructureComplete;
