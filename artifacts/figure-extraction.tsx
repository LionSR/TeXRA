import React, { useState } from 'react';
import { FileImage, FileSearch, RefreshCcw, ArrowRight, CheckCircle2 } from 'lucide-react';

const inputPaper = `\\section{Numerical Results}\n
We analyze the thermal properties using tensor network methods.\n
\\begin{figure}[t]
  \\includegraphics{thermal_state.pdf}
  \\caption{Convergence of free energy for the 2D Heisenberg model at $\\beta J = 1.0$. 
    The bond dimension $\\chi$ ranges from 20 to 100.}
\\end{figure}\n
The convergence behavior indicates rapid equilibration.`;

const r0Output = `\\section{Numerical Results}\n
We analyze the thermal properties using tensor network methods.\n
\\begin{figure}[t]
  \\includegraphics{thermal_state.pdf}
  \\caption{<diff-add>Tensor network</diff-add> convergence of free energy for the 2D Heisenberg model at $\\beta J = 1.0$. 
    The bond dimension $\\chi$ ranges from 20 to 100<diff-add>, demonstrating exponential improvement in accuracy</diff-add>.
    <diff-add>Error bars indicate standard deviation over 100 random initial states.</diff-add>}
\\end{figure}\n
The convergence behavior indicates <diff-add>exponentially fast</diff-add> equilibration.`;

const r1Output = `\\section{Numerical Results}\n
We analyze the thermal properties using <diff-add>imaginary time</diff-add> tensor network methods.\n
\\begin{figure}[t]
  \\includegraphics{thermal_state.pdf}
  \\caption{Tensor network convergence of free energy for the 2D Heisenberg model at $\\beta J = 1.0$. 
    The bond dimension $\\chi$ ranges from 20 to 100, demonstrating exponential improvement in accuracy.
    Error bars indicate standard deviation over 100 random initial states.
    <diff-add>Dashed line shows exact diagonalization results for $4\\times4$ lattice as benchmark.</diff-add>}
\\end{figure}\n
The convergence behavior indicates exponentially fast equilibration<diff-add>, matching known exact results within error bars</diff-add>.`;

const DummyFigure = () => (
  <svg className="w-full h-48 bg-gray-100 rounded border border-gray-200" viewBox="0 0 300 200">
    {/* Axes */}
    <line x1="40" y1="160" x2="280" y2="160" stroke="#666" strokeWidth="2"/>
    <line x1="40" y1="160" x2="40" y2="20" stroke="#666" strokeWidth="2"/>
    
    {/* Main convergence line */}
    <path d="M 40,140 Q 100,80 280,40" fill="none" stroke="#2563eb" strokeWidth="2"/>
    
    {/* Error bars */}
    {[60, 120, 180, 240].map((x, i) => (
      <line 
        key={i}
        x1={x} 
        y1={120 - i * 15} 
        x2={x} 
        y2={140 - i * 15} 
        stroke="#4b5563" 
        strokeWidth="1"
      />
    ))}
    
    {/* Benchmark dashed line */}
    <path 
      d="M 40,120 L 280,35" 
      stroke="#dc2626" 
      strokeWidth="2" 
      strokeDasharray="4 4"
    />
    
    {/* Labels */}
    <text x="160" y="180" textAnchor="middle" fill="#374151">Bond dimension χ</text>
    <text x="30" y="90" textAnchor="end" fill="#374151" transform="rotate(-90 30 90)">Free energy</text>
    <text x="250" y="30" textAnchor="end" fill="#dc2626" fontSize="12">Exact</text>
  </svg>
);

const ExtractionStatus = ({ completed }) => (
  <div className="flex items-center gap-2 text-sm">
    <CheckCircle2 className={`w-4 h-4 ${completed ? 'text-green-600' : 'text-gray-300'}`} />
    <span className={completed ? 'text-green-600' : 'text-gray-500'}>
      {completed ? 'Extracted' : 'Pending'}
    </span>
  </div>
);

const DiffText = ({ text }) => {
  const parts = text.split(/((?:<diff-add>.*?<\/diff-add>)|(?:<diff-del>.*?<\/diff-del>))/g);
  return (
    <>
      {parts.map((part, i) => {
        if (part?.startsWith('<diff-add>')) {
          return <span key={i} className="bg-green-100 text-green-800">{part.replace(/<\/?diff-add>/g, '')}</span>;
        }
        if (part?.startsWith('<diff-del>')) {
          return <span key={i} className="bg-red-100 text-red-800 line-through">{part.replace(/<\/?diff-del>/g, '')}</span>;
        }
        return part;
      })}
    </>
  );
};

const FigureExtractionWorkflow = () => {
  const [currentStep, setCurrentStep] = useState(1);
  const [extractionComplete, setExtractionComplete] = useState(false);
  
  React.useEffect(() => {
    const timer = setTimeout(() => {
      setExtractionComplete(true);
    }, 1000);
    return () => clearTimeout(timer);
  }, []);

  return (
    <div className="w-full max-w-6xl mx-auto p-8 bg-white rounded-lg shadow-lg">
      <h2 className="text-2xl font-bold text-gray-800 mb-6 text-center">
        Tool Use: Figure Extraction and Caption Enhancement
      </h2>

      {/* Instruction Box */}
      <div className="mb-6 p-4 bg-blue-50 rounded-lg border border-blue-200">
        <h3 className="font-semibold text-blue-800 mb-2">Instruction:</h3>
        <p className="text-blue-900">Update the figure caption to better describe the numerical convergence results and add comparison with exact diagonalization.</p>
      </div>

      <div className="grid grid-cols-3 gap-6">
        {/* Input Stage */}
        <div className="bg-gray-50 rounded-lg p-4 border border-gray-200">
          <div className="flex items-center gap-2 mb-4">
            <FileImage className="w-5 h-5 text-blue-600" />
            <h3 className="font-semibold">Input Paper</h3>
          </div>
          <pre className="text-sm whitespace-pre-wrap bg-white p-3 rounded border border-gray-200 mb-4">
            {inputPaper}
          </pre>
        </div>

        {/* Extraction Stage */}
        <div className="bg-gray-50 rounded-lg p-4 border border-gray-200">
          <div className="flex items-center gap-2 mb-4">
            <FileSearch className="w-5 h-5 text-green-600" />
            <h3 className="font-semibold">Extracted Figure</h3>
          </div>
          
          <div className="space-y-4">
            <div>
              <div className="flex justify-between mb-2">
                <span className="text-sm font-medium">thermal_state.pdf</span>
                <ExtractionStatus completed={extractionComplete} />
              </div>
              <DummyFigure />
            </div>
          </div>
        </div>

        {/* Output Stage */}
        <div className="bg-gray-50 rounded-lg p-4 border border-gray-200">
          <div className="flex items-center gap-2 mb-4">
            <RefreshCcw className="w-5 h-5 text-purple-600" />
            <h3 className="font-semibold">Enhanced Output</h3>
          </div>
          <pre className="text-sm whitespace-pre-wrap bg-white p-3 rounded border border-gray-200 mb-4">
            <DiffText text={currentStep === 1 ? r0Output : r1Output} />
          </pre>
        </div>
      </div>

      {/* Progress Controls */}
      <div className="mt-6 flex justify-between items-center p-4 bg-gray-50 rounded-lg">
        <div className="flex gap-4">
          <button 
            className={`px-4 py-2 rounded ${currentStep === 1 ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-600'}`}
            onClick={() => setCurrentStep(1)}
          >
            Initial Output (R0)
          </button>
          <button 
            className={`px-4 py-2 rounded ${currentStep === 2 ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-600'}`}
            onClick={() => setCurrentStep(2)}
          >
            Refined Output (R1)
          </button>
        </div>
        <div className="flex items-center gap-2">
          <div className="h-2 w-12 rounded bg-blue-600"></div>
          <ArrowRight className="w-4 h-4 text-gray-400" />
          <div className={`h-2 w-12 rounded ${currentStep >= 2 ? 'bg-blue-600' : 'bg-gray-200'}`}></div>
        </div>
      </div>
    </div>
  );
};

export default FigureExtractionWorkflow;