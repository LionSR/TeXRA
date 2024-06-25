import re
import os
import subprocess
import argparse
from string import Template
from pathlib import Path

TEMPLATE_TEX = Template(
    r"""
\documentclass[tikz,border=10pt]{standalone}
\usepackage{tikz}
\usetikzlibrary{positioning}
\input{commands}

% Add any other necessary packages or TikZ libraries here
\begin{document}
$tikzpicture
\end{document}
"""
)


def extract_tikzpictures(latex_file):
    with open(latex_file, "r") as file:
        content = file.read()

    # Regular expression to match tikzpicture environments
    pattern = r"\\begin{tikzpicture}.*?\\end{tikzpicture}"
    tikzpictures = re.findall(pattern, content, re.DOTALL)

    return tikzpictures


def create_standalone_latex(tikzpicture, index, build_dir):
    filename = build_dir / f"tikzpicture_{index}.tex"

    with open(filename, "w") as file:
        file.write(TEMPLATE_TEX.substitute(tikzpicture=tikzpicture))

    return filename


def compile_latex_to_pdf(tex_file):
    try:
        result = subprocess.run(
            ["pdflatex", "-interaction=nonstopmode", f"-output-directory={tex_file.parent}", tex_file], check=True, capture_output=True, text=True
        )
        print(f"Compiled {tex_file} successfully.")
    except subprocess.CalledProcessError as e:
        print(f"Error compiling {tex_file}")
        print("Error message:")
        print(e.stdout)
        print(e.stderr)


def main(latex_file):
    input_file = Path(latex_file)
    build_dir = Path("build") / input_file.stem
    build_dir.mkdir(parents=True, exist_ok=True)

    tikzpictures = extract_tikzpictures(latex_file)

    for index, tikzpicture in enumerate(tikzpictures, start=1):
        tex_file = create_standalone_latex(tikzpicture, index, build_dir)
        compile_latex_to_pdf(tex_file)

        # Clean up auxiliary files
        for ext in [".aux", ".log"]:
            aux_file = tex_file.with_suffix(ext)
            if aux_file.exists():
                aux_file.unlink()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Extract and compile TikZ pictures from a LaTeX file.")
    parser.add_argument("input_file", help="Path to the input LaTeX file")
    args = parser.parse_args()

    main(args.input_file)
