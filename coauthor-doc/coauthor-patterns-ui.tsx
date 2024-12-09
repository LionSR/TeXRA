import React, { useState } from 'react';
import { 
  FileText, RefreshCcw, Wrench, GitMerge, 
  Scroll, Package, Trash2, GitBranch, 
  FolderTree, History, FileCode, ArrowRight
} from 'lucide-react';

const TITLE = "CoAuthor: AI Agent Patterns for Academic Writing";

const ModelSelector = () => (
  <div className="grid grid-cols-3 gap-4 mb-6 bg-white p-4 rounded-lg shadow">
    <div className="space-y-2">
      <label className="text-sm font-medium text-gray-700">Agent:</label>
      <select className="w-full p-2 border rounded bg-white">
        <option>correct_tex</option>
        <option>polish_tex</option>
        <option>draw_tex</option>
        <option>write_tex</option>
        <option>meeting2text</option>
        <option>text2tex</option>
        <option>paper2note</option>
        <option>paper2cover</option>
        <option>paper2slide</option>
        <option>paper2poster</option>
        <option>slide2paper</option>
      </select>
    </div>
    <div className="space-y-2">
      <label className="text-sm font-medium text-gray-700">Model:</label>
      <select className="w-full p-2 border rounded bg-white">
        <option>Anthropic Claude 3 Opus</option>
        <option>Anthropic Claude 3 Sonnet</option>
        <option>OpenAI GPT-4 Turbo</option>
        <option>OpenAI GPT-4</option>
        <option>OpenAI GPT O1</option>
        <option>Google Gemini 1.5 Pro</option>
      </select>
    </div>
    <div className="space-y-2">
      <label className="text-sm font-medium text-gray-700">Reflect:</label>
      <select className="w-full p-2 border rounded bg-white">
        <option>True</option>
        <option>False</option>
      </select>
    </div>
  </div>
);

const PatternCard = ({ icon: Icon, title, description, content }) => (
  <div className="bg-white rounded-lg shadow p-4 mb-4">
    <div className="flex items-center gap-2 mb-3">
      <Icon className="w-5 h-5 text-blue-600" />
      <h3 className="font-medium">{title}</h3>
    </div>
    <p className="text-sm text-gray-600 mb-3">{description}</p>
    <div className="bg-gray-50 rounded-lg p-3">
      {content}
    </div>
  </div>
);

const DiffExample = () => (
  <div className="font-mono text-sm p-2 border rounded mb-2">
    <div className="flex items-center gap-2">
      <div className="bg-blue-100 text-blue-800 px-2 py-1 rounded">+</div>
      <code>Added content in blue</code>
    </div>
    <div className="flex items-center gap-2">
      <div className="bg-red-100 text-red-800 px-2 py-1 rounded">-</div>
      <code className="line-through">Removed content in red</code>
    </div>
  </div>
);

const FileManagement = () => (
  <div className="grid grid-cols-2 gap-4 mb-4">
    <div className="bg-white p-4 rounded-lg shadow">
      <h4 className="font-medium mb-2 flex items-center gap-2">
        <Package className="w-4 h-4 text-orange-600" />
        Pack & Clean
      </h4>
      <div className="text-sm space-y-1 text-gray-600">
        <div>• pack-single: Organize output into versioned folders</div>
        <div>• pack-multiple: Handle multiple related files</div>
        <div>• clean-output: Remove generated files</div>
        <div>• clean-build: Clear build directories</div>
      </div>
    </div>
    <div className="bg-white p-4 rounded-lg shadow">
      <h4 className="font-medium mb-2 flex items-center gap-2">
        <History className="w-4 h-4 text-purple-600" />
        Version Control
      </h4>
      <div className="text-sm space-y-1 text-gray-600">
        <div>• latexdiff: Visual comparison between versions</div>
        <div>• latexdiff-vc: Git integration for version tracking</div>
        <div>• Automated diff generation and compilation</div>
      </div>
    </div>
  </div>
);

const CoAuthorPatternsUI = () => {
  return (
    <div className="max-w-4xl mx-auto p-6 space-y-6">
      <ModelSelector />

      <PatternCard
        icon={FileText}
        title="Long Context Processing"
        description="Support for extensive academic documents"
        content={
          <div className="space-y-4 text-sm">
            <div className="grid grid-cols-2 gap-4">
              <div className="p-3 bg-blue-50 rounded">
                <span className="font-medium text-blue-800">Claude Models:</span>
                <div>200K tokens (~150 pages)</div>
              </div>
              <div className="p-3 bg-green-50 rounded">
                <span className="font-medium text-green-800">GPT Models:</span>
                <div>128K tokens (~100 pages)</div>
              </div>
            </div>
            <div className="bg-gray-50 p-3 rounded border border-gray-200">
              <div className="font-medium mb-2">Example System Prompt:</div>
              <pre className="text-xs whitespace-pre-wrap">You are an AI trained to process and enhance lengthy LaTeX documents. You can handle academic papers, including all sections, equations, figures, and references. Focus on maintaining document coherence across long contexts.</pre>
            </div>
          </div>
        }
      />

      <PatternCard
        icon={Scroll}
        title="Planning via Scratchpad (Wei et al., 2022)"
        description="Chain-of-Thought prompting through structured XML tags"
        content={
          <pre className="text-xs whitespace-pre-wrap">
            {`<scratchpad>
1. [Content Analysis]
   • Review document structure
   • Identify improvement areas

2. [Enhancement Plan]
   • Update methodology section
   • Revise figure captions
   • Standardize notation
</scratchpad>`}
          </pre>
        }
      />

      <PatternCard
        icon={RefreshCcw}
        title="Reflection & Iteration (Shinn et al., 2023)"
        description="Verbal reinforcement learning through multi-round refinement"
        content={
          <div className="space-y-3">
            <div className="text-sm space-y-1">
              <div>• paper_r0_model.tex - Initial output</div>
              <div>• paper_r1_model.tex - Refined output</div>
              <div>• paper_r1_model_diff.tex - Visual changes:</div>
            </div>
            <DiffExample />
          </div>
        }
      />

      <PatternCard
        icon={GitMerge}
        title="Multi-Agent Process"
        description="Specialized merge workflow with multiple agents"
        content={
          <div className="space-y-3 text-sm">
            <div className="p-3 border rounded bg-purple-50">
              <div className="flex items-center gap-2 font-medium text-purple-800 mb-2">
                <div className="bg-purple-200 px-2 py-1 rounded">Agent 1</div>
                <ArrowRight className="w-4 h-4" />
                <div className="flex-grow">Strategy Generation</div>
              </div>
              <pre className="text-xs bg-white p-2 rounded">Analyze differences and generate merge plan</pre>
            </div>
            <div className="p-3 border rounded bg-indigo-50">
              <div className="flex items-center gap-2 font-medium text-indigo-800 mb-2">
                <div className="bg-indigo-200 px-2 py-1 rounded">Agent 2</div>
                <ArrowRight className="w-4 h-4" />
                <div className="flex-grow">Implementation</div>
              </div>
              <pre className="text-xs bg-white p-2 rounded">Execute merge plan systematically</pre>
            </div>
          </div>
        }
      />

      <PatternCard
        icon={Wrench}
        title="Tool Integration"
        description="LaTeX tools and file management utilities"
        content={
          <div className="space-y-4">
            <div className="text-sm grid grid-cols-2 gap-4">
              <div>
                <div className="font-medium mb-1">Document Processing:</div>
                <div className="space-y-1">
                  <div>• latexdiff generation</div>
                  <div>• TikZ figure extraction</div>
                  <div>• LaTeX indentation</div>
                </div>
              </div>
              <div>
                <div className="font-medium mb-1">File Operations:</div>
                <div className="space-y-1">
                  <div>• Build process integration</div>
                  <div>• Version management</div>
                  <div>• Log database tracking</div>
                </div>
              </div>
            </div>
            <FileManagement />
          </div>
        }
      />
    </div>
  );
};

export default CoAuthorPatternsUI;