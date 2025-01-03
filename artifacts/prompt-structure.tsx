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

interface PromptComponent {
  title: string;
  icon: React.ReactNode;
  description: string;
  preview: string;
  color: string;
  output?: {
    title: string;
    preview: string;
  };
}

interface FormState {
  selectedFile: string;
  selectedAux: string;
  instruction: string;
}

const PROMPT_COMPONENTS: Record<string, PromptComponent> = {
  systemPrompt: {
    title: "System Prompt",
    icon: <Settings className="w-6 h-6 text-blue-600" />,
    description: "Sets core behavior and requirements",
    preview:
      "You are an expert in programming LaTeX and physics.\nYour task is to use your knowledge to improve a LaTeX research paper.\nWhen writing a professional *.tex document, you must:\n- Follow best practices that will result in zero chktex warnings\n- Use \\cref{} for references instead of pure numbers\n- Use commands defined in commands.tex",
    color: "blue",
  },
  userPrefix: {
    title: "User Prefix",
    icon: <MessageSquare className="w-6 h-6 text-green-600" />,
    description: "Loads documents and context",
    preview:
      "Here is the LaTeX document with input files:\n<documents>\n<document name='commands.tex'>\\newcommand{\\op}{\\hat{O}}</document>\n<document name='paper.tex'>\n{{INPUT_CONTENT}}\n</document>\n</documents>\n\nPlease read through the research paper and understand all details.",
    color: "green",
  },
  userRequest: {
    title: "User Request",
    icon: <Send className="w-6 h-6 text-orange-600" />,
    description: "Specifies task and instructions",
    preview:
      "Your task is to enhance this paper focusing on:\n<instruction>\nImprove the clarity of Section 2\n</instruction>\n\n<scratchpad>\n1. [Improve equation explanations]\n   • Rationale: Current derivations lack detail\n   • Steps: Add intermediate steps in eq(2.3)\n</scratchpad>\n\n<latex_document>\n\\documentclass{article}\n...\n\\end{latex_document}",
    color: "orange",
    output: {
      title: "Initial Edited Document",
      preview:
        "paper_correct_r0_sonnet++.tex\npaper_correct_r0_sonnet++_diff.tex (vs paper.tex)\n• Red: Added content (e.g., +\\begin{equation})\n• Blue: Deleted content (e.g., -unclear explanation)\n• Generated using latexdiff with --flatten\n• PDF preview with highlighted changes",
    },
  },
  userReflect: {
    title: "Reflection Phase",
    icon: <RefreshCcw className="w-6 h-6 text-purple-600" />,
    description: "Analysis and refinement",
    preview:
      "<reflection>\n1. Changes address clarity but could add more examples\n2. Equation flow improved but notation needs standardization\n</reflection>\n\n<idea>\n1. [Add illustrative example]\n   • Rationale: Reinforce theoretical concepts\n   • Steps: Insert numerical example after eq(2.5)\n</idea>\n\n<latex_document>\n\\documentclass{article}\n...\n\\end{latex_document}",
    color: "purple",
    output: {
      title: "Final Edited Document",
      preview:
        "paper_correct_r1_sonnet++.tex\npaper_correct_r1_sonnet++_diff.tex (vs paper.tex)\npaper_correct_r1_sonnet++_diff_r1r0.tex (vs r0)\n• Tracks both cumulative and incremental changes\n• Generated using latexdiff with color coding\n• Shows evolution of improvements",
    },
  },
};

const SELECT_OPTIONS = {
  files: [
    { value: "paper.tex", label: "paper.tex" },
    { value: "draft.tex", label: "draft.tex" },
  ],
  auxiliary: [
    { value: "commands.tex", label: "commands.tex" },
    { value: "macros.tex", label: "macros.tex" },
  ],
};

const FileSelectionPanel: React.FC<{
  formState: FormState;
  onChange: (field: keyof FormState, value: string) => void;
}> = ({ formState, onChange }) => (
  <div className="mb-8 grid grid-cols-2 gap-6">
    <div className="p-4 bg-gray-50 rounded-lg border border-gray-200">
      <div className="mb-4">
        <label className="block text-sm font-medium text-gray-700 mb-2">
          Select Input File:
        </label>
        <select
          className="w-full p-2 border border-gray-300 rounded-md bg-white"
          value={formState.selectedFile}
          onChange={(e) => onChange("selectedFile", e.target.value)}
        >
          {SELECT_OPTIONS.files.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">
          Select Auxiliary File:
        </label>
        <select
          className="w-full p-2 border border-gray-300 rounded-md bg-white"
          value={formState.selectedAux}
          onChange={(e) => onChange("selectedAux", e.target.value)}
        >
          {SELECT_OPTIONS.auxiliary.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
    </div>

    <div className="p-4 bg-gray-50 rounded-lg border border-gray-200">
      <label className="block text-sm font-medium text-gray-700 mb-2">
        Specific Instructions:
      </label>
      <textarea
        className="w-full p-2 border border-gray-300 rounded-md bg-white h-32 resize-none"
        value={formState.instruction}
        onChange={(e) => onChange("instruction", e.target.value)}
        placeholder="Enter specific instructions..."
      />
    </div>
  </div>
);

const ProcessOverview: React.FC = () => (
  <div className="mt-8 flex justify-between items-center p-4 bg-gray-50 rounded-lg border border-gray-200">
    <div className="flex items-center space-x-2">
      {[
        { Icon: FileText, color: "text-gray-400" },
        { Icon: Settings, color: "text-blue-600" },
        { Icon: MessageSquare, color: "text-green-600" },
        { Icon: Send, color: "text-orange-600" },
        { Icon: FileOutput, color: "text-green-600" },
        { Icon: RefreshCcw, color: "text-purple-600" },
        { Icon: FileOutput, color: "text-green-600" },
      ].map(({ Icon, color }, index, array) => (
        <React.Fragment key={index}>
          <Icon className={`w-6 h-6 ${color}`} />
          {index < array.length - 1 && (
            <ArrowRight className="w-4 h-4 text-gray-400" />
          )}
        </React.Fragment>
      ))}
    </div>
  </div>
);

const PromptStructureComplete: React.FC = () => {
  const [activeSection, setActiveSection] = useState("systemPrompt");
  const [formState, setFormState] = useState<FormState>({
    selectedFile: "paper.tex",
    selectedAux: "commands.tex",
    instruction: "Improve the clarity of Section 2",
  });

  const handleFormChange = (field: keyof FormState, value: string) => {
    setFormState((prev) => ({ ...prev, [field]: value }));
  };

  const getBorderColor = (key: string) => {
    const component = PROMPT_COMPONENTS[key];
    return activeSection === key
      ? `border-${component.color}-500 bg-${component.color}-50`
      : "border-gray-200";
  };

  return (
    <div className="w-full max-w-6xl mx-auto p-8 bg-white rounded-lg shadow-lg">
      <h2 className="text-2xl font-bold text-gray-800 mb-8 text-center">
        Prompt Structure
      </h2>

      <FileSelectionPanel formState={formState} onChange={handleFormChange} />

      <div className="flex flex-col space-y-4">
        {Object.entries(PROMPT_COMPONENTS).map(([key, component]) => (
          <div key={key} className="flex items-stretch space-x-4">
            <div
              className={`flex-1 p-4 rounded-lg border-2 transition-all duration-200 cursor-pointer ${getBorderColor(key)}`}
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
                  <p className="text-sm text-green-700 whitespace-pre-line">
                    {component.output.preview}
                  </p>
                </div>
              </>
            )}
          </div>
        ))}
      </div>

      <ProcessOverview />
    </div>
  );
};

export default PromptStructureComplete;
