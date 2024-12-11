import React, { useState } from "react";
import {
  FileText,
  Image,
  Code,
  ArrowDownCircle,
  RefreshCcw,
  Check,
  ChevronDown,
  ChevronRight,
  FileCode,
  Settings,
  MessageSquare,
  Terminal,
  FileOutput,
  AlertCircle,
  PenTool,
  Wand2,
} from "lucide-react";

const initialCode =
  "\\begin{tikzpicture}\n  % Basic grid only\n  \\draw[gray!30] (0,0) grid (4,4);\n\\end{tikzpicture}";

const r0Code =
  "\\begin{tikzpicture}\n" +
  "  % Basic vector field\n" +
  "  \\foreach \\i in {0,...,4} {\n" +
  "    \\foreach \\j in {0,...,4} {\n" +
  "      \\draw[->] (\\i,\\j) -- (\\i+0.7,\\j+0.3);\n" +
  "    }\n" +
  "  }\n" +
  "\\end{tikzpicture}";

const r1Code =
  "\\begin{tikzpicture}\n" +
  "  % Professional vector field\n" +
  "  \\definecolor{flowblue}{RGB}{74,144,226}\n" +
  "  \\foreach \\i in {0,...,4} {\n" +
  "    \\foreach \\j in {0,...,4} {\n" +
  "      \\pgfmathsetmacro{\\angle}{sin(\\i*50)*cos(\\j*40)}\n" +
  "      \\draw[->, flowblue] (\\i,\\j) -- \n" +
  "        (\\i+0.7*cos(\\angle),\\j+0.7*sin(\\angle));\n" +
  "    }\n" +
  "  }\n" +
  "  % Add streamlines\n" +
  "  \\draw[flowblue!40, dashed] plot[smooth] \n" +
  "    coordinates {(0,2) (2,1.8) (4,2.2)};\n" +
  "\\end{tikzpicture}";

const ExtractionBox = ({ icon: Icon, title, children, expanded, onToggle }) => (
  <div className="bg-white rounded-lg shadow p-4 mb-4">
    <div
      className="flex items-center gap-2 mb-2 cursor-pointer"
      onClick={onToggle}
    >
      <Icon className="w-5 h-5 text-blue-600" />
      <h3 className="font-medium flex-grow">{title}</h3>
      {expanded ? (
        <ChevronDown className="w-4 h-4 text-gray-400" />
      ) : (
        <ChevronRight className="w-4 h-4 text-gray-400" />
      )}
    </div>
    {expanded && children}
  </div>
);

const ProcessStep = ({ icon: Icon, text, status }) => (
  <div className="flex items-center gap-2 text-sm p-2 bg-gray-50 rounded mb-2">
    <Icon className="w-4 h-4 text-blue-600" />
    <span className="flex-grow">{text}</span>
    {status === "done" && <Check className="w-4 h-4 text-green-500" />}
    {status === "processing" && (
      <RefreshCcw className="w-4 h-4 text-blue-500 animate-spin" />
    )}
  </div>
);

const FlowFieldVisualization = ({ version }) => (
  <svg className="w-full h-48 bg-white border rounded" viewBox="0 0 400 300">
    {/* Grid */}
    {Array.from({ length: 6 }, (_, i) => (
      <React.Fragment key={i}>
        <line
          x1={0}
          y1={i * 50 + 25}
          x2={400}
          y2={i * 50 + 25}
          stroke="#f0f0f0"
        />
        <line
          x1={i * 80 + 25}
          y1={0}
          x2={i * 80 + 25}
          y2={300}
          stroke="#f0f0f0"
        />
      </React.Fragment>
    ))}

    {/* Vectors - simpler for R0, more refined for R1 */}
    {Array.from({ length: 5 }, (_, i) =>
      Array.from({ length: 4 }, (_, j) => {
        const x = 50 + i * 80;
        const y = 50 + j * 50;
        const angle =
          version === "r1" ? Math.sin(x / 100) * Math.cos(y / 100) : 0.3;
        const color = version === "r1" ? "#4a90e2" : "#666";
        return (
          <line
            key={`v-${i}-${j}`}
            x1={x}
            y1={y}
            x2={x + Math.cos(angle) * 30}
            y2={y + Math.sin(angle) * 30}
            stroke={color}
            strokeWidth={version === "r1" ? "2" : "1"}
            markerEnd={`url(#arrow-${version})`}
          />
        );
      }),
    )}

    {/* Streamlines for R1 */}
    {version === "r1" && (
      <path
        d="M 50,150 C 100,140 150,160 200,150 S 300,140 350,150"
        fill="none"
        stroke="rgba(74,144,226,0.3)"
        strokeWidth="2"
        strokeDasharray="5,5"
      />
    )}

    <defs>
      <marker
        id={`arrow-${version}`}
        markerWidth="10"
        markerHeight="7"
        refX="9"
        refY="3.5"
        orient="auto"
      >
        <polygon
          points="0 0, 10 3.5, 0 7"
          fill={version === "r1" ? "#4a90e2" : "#666"}
        />
      </marker>
    </defs>
  </svg>
);

const TikzWorkflowVertical = () => {
  const [expanded, setExpanded] = useState({
    input: true,
    r0: false,
    r1: false,
  });

  return (
    <div className="max-w-3xl mx-auto p-6 bg-gray-50">
      {/* Header Section */}
      <div className="bg-white rounded-lg shadow p-4 mb-6">
        <div className="flex items-center gap-4 mb-4">
          <div className="flex items-center gap-2">
            <PenTool className="w-5 h-5 text-blue-600" />
            <span className="font-medium">draw_tex</span>
          </div>
          <div className="flex items-center gap-2">
            <Wand2 className="w-5 h-5 text-purple-600" />
            <span className="font-medium">sonnet++</span>
          </div>
        </div>

        <div className="bg-blue-50 p-3 rounded">
          <h3 className="font-medium text-blue-800 mb-2">Instruction:</h3>
          <p className="text-blue-900">
            Draw a TikZ figure showing the flow field with velocity vectors and
            streamlines
          </p>
        </div>
      </div>

      {/* Input Section */}
      <ExtractionBox
        icon={FileText}
        title="Input: paper.tex with target figure"
        expanded={expanded.input}
        onToggle={() =>
          setExpanded((prev) => ({ ...prev, input: !prev.input }))
        }
      >
        <div className="space-y-4">
          <ProcessStep
            icon={Image}
            text="Extracting: paper/figs/flow_field.pdf"
            status="done"
          />
          <FlowFieldVisualization version="target" />
        </div>
      </ExtractionBox>

      {/* Compilation Arrow */}
      <div className="flex justify-center my-4">
        <ArrowDownCircle className="w-6 h-6 text-blue-500" />
      </div>

      {/* R0 Section */}
      <ExtractionBox
        icon={FileCode}
        title="Initial TikZ Generation (R0)"
        expanded={expanded.r0}
        onToggle={() => setExpanded((prev) => ({ ...prev, r0: !prev.r0 }))}
      >
        <div className="space-y-4">
          <ProcessStep
            icon={Code}
            text="Generating: flow_field_draw_r0.tex"
            status="done"
          />
          <ProcessStep icon={Terminal} text="Compiling LaTeX" status="done" />
          <FlowFieldVisualization version="r0" />
          {expanded.r0 && (
            <pre className="text-xs bg-gray-50 p-2 rounded overflow-x-auto">
              {r0Code}
            </pre>
          )}
        </div>
      </ExtractionBox>

      {/* Reflection Arrow */}
      <div className="flex justify-center my-4">
        <div className="flex flex-col items-center">
          <RefreshCcw className="w-6 h-6 text-purple-500" />
          <span className="text-sm text-gray-600 mt-1">
            Reflection & Improvement
          </span>
        </div>
      </div>

      {/* R1 Section */}
      <ExtractionBox
        icon={FileOutput}
        title="Enhanced TikZ Output (R1)"
        expanded={expanded.r1}
        onToggle={() => setExpanded((prev) => ({ ...prev, r1: !prev.r1 }))}
      >
        <div className="space-y-4">
          <ProcessStep
            icon={Settings}
            text="Improving vector field styling"
            status="done"
          />
          <ProcessStep
            icon={MessageSquare}
            text="Adding streamlines"
            status="done"
          />
          <FlowFieldVisualization version="r1" />
          {expanded.r1 && (
            <pre className="text-xs bg-gray-50 p-2 rounded overflow-x-auto">
              {r1Code}
            </pre>
          )}
        </div>
      </ExtractionBox>

      {/* Output Files */}
      <div className="mt-4 p-4 bg-white rounded-lg shadow">
        <h3 className="font-medium mb-2 flex items-center gap-2">
          <AlertCircle className="w-5 h-5 text-blue-600" />
          Generated Files
        </h3>
        <div className="text-sm text-gray-600 space-y-1">
          <div>• flow_field_draw_r0.tex → flow_field_draw_r0.pdf</div>
          <div>• flow_field_draw_r1.tex → flow_field_draw_r1.pdf</div>
          <div>• flow_field_draw_r1_diff.tex (vs r0)</div>
        </div>
      </div>
    </div>
  );
};

export default TikzWorkflowVertical;
