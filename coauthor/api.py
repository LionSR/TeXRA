from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel
from typing import List, Optional
import subprocess
import sys
import os
from dotenv import load_dotenv

# Import necessary functions from your existing modules
from coauthor.arg_utils import comma_separated_list
from coauthor.figure_tools import extract_figure_paths, extract_and_compile_tikzpictures_with_labels
from coauthor.tex_tools import run_latexdiff, run_latexdiff_vc, run_latexdiff_vc_multiple, get_tex_count
from coauthor.housekeeping_utils import (
    run_clean_single,
    run_pack_single,
    run_clean_build,
    run_indent_tex,
    run_clean_output,
    run_clean_multiple,
    run_pack_multiple,
    run_pack_latexdiff_vc,
    run_pack_latexdiff_vc_multiple,
)

router = APIRouter()

# Add the parent directory to the system path for the windows users
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

load_dotenv()


def get_common_env(model):
    if model is None:
        model = os.getenv("MODEL", "sonnet+")
    script_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    prompt_dir = os.getenv("PROMPT_DIR", f"{script_dir}/agents")
    return model, script_dir, prompt_dir


def execute_agent(script, agent, model, input_file, **kwargs):
    model, script_dir, _ = get_common_env(model)
    command = [
        "python",
        f"{script_dir}/agents/{script}.py",
        f"--agent={agent}",
        f"--model={model}",
        f"--input_file={input_file}",
    ]

    for key, value in kwargs.items():
        if value is not None:
            if isinstance(value, bool):
                if value:
                    command.append(f"--{key}")
            elif key in ["input_files", "figure_inputs", "auxiliary_files", "output_files"]:
                if isinstance(value, str):
                    value = [value]
                command.append(f"--{key}")
                command.append(",".join(map(str, value)))
            else:
                command.append(f"--{key}")
                command.append(str(value))

    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode != 0:
        raise HTTPException(status_code=500, detail=f"Agent execution failed: {result.stderr}")
    return result.stdout


class SharedArgs(BaseModel):
    input_file: str
    model: Optional[str] = "sonnet+"
    reflect: Optional[str] = None
    instruction: Optional[str] = None
    input_files: Optional[str] = None
    sample_files: Optional[str] = None
    auxiliary_files: Optional[str] = None
    figure_inputs: Optional[str] = None
    edited_file: Optional[str] = None
    auto_extract_figure: Optional[bool] = False
    auto_extract_tikz_figure: Optional[bool] = False
    include_tikz_reflection: Optional[bool] = False
    include_tex_count: Optional[bool] = False
    output_files: Optional[List[str]] = None
    output_name_override: Optional[str] = None


@router.post("/correct_tex")
async def correct_tex(args: SharedArgs):
    agent = "correct"
    if args.output_files:
        agent = f"{agent}_multiple"
    elif args.auxiliary_files:
        agent = f"{agent}_with_auxiliary"
    return execute_agent("edit_tex", agent, args.model, args.input_file, **args.dict())


@router.post("/polish_tex")
async def polish_tex(args: SharedArgs):
    agent = "polish"
    if args.output_files:
        agent = f"{agent}_multiple"
    elif args.auxiliary_files:
        agent = f"{agent}_with_auxiliary"
    return execute_agent("edit_tex", agent, args.model, args.input_file, **args.dict())


@router.post("/draw_tex")
async def draw_tex(args: SharedArgs):
    agent = "draw"
    if args.output_files:
        agent = f"{agent}_multiple"
    elif args.auxiliary_files:
        agent = f"{agent}_with_auxiliary"
    return execute_agent("edit_tex", agent, args.model, args.input_file, **args.dict())


@router.post("/correct_qi")
async def correct_qi(args: SharedArgs):
    return execute_agent("edit_lecture", "correct_qi", args.model, args.input_file, **args.dict())


@router.post("/correct_st")
async def correct_st(args: SharedArgs):
    return execute_agent("edit_lecture", "correct_st", args.model, args.input_file, **args.dict())


@router.post("/polish_st")
async def polish_st(args: SharedArgs):
    agent = "polish_st"
    if args.output_files:
        agent = f"{agent}_multiple"
    return execute_agent("edit_lecture", agent, args.model, args.input_file, **args.dict())


@router.post("/polish_qi")
async def polish_qi(args: SharedArgs):
    agent = "polish_qi"
    if args.output_files:
        agent = f"{agent}_multiple"
    return execute_agent("edit_lecture", agent, args.model, args.input_file, **args.dict())


@router.post("/revise_st")
async def revise_st(args: SharedArgs):
    agent = "revise_st"
    if args.output_files:
        agent = f"{agent}_multiple"
    return execute_agent("edit_lecture", agent, args.model, args.input_file, **args.dict())


@router.post("/draw_st")
async def draw_st(args: SharedArgs):
    agent = "draw_st"
    if args.output_files:
        agent = f"{agent}_multiple"
    return execute_agent("edit_lecture", agent, args.model, args.input_file, **args.dict())


@router.post("/draw_qi")
async def draw_qi(args: SharedArgs):
    agent = "draw_qi"
    if args.output_files:
        agent = f"{agent}_multiple"
    return execute_agent("edit_lecture", agent, args.model, args.input_file, **args.dict())


class Meeting2TextArgs(SharedArgs):
    example_transcript: Optional[str] = None
    example_edited_transcript: Optional[str] = None


@router.post("/meeting2text")
async def meeting2text(args: Meeting2TextArgs):
    return execute_agent("meeting2text", "transcribe_dual", args.model, args.input_file, **args.dict())


class Txt2TexArgs(SharedArgs):
    sample_tex: Optional[str] = None
    document_cls: Optional[str] = None
    commands_file: Optional[str] = None


@router.post("/txt2tex")
async def txt2tex(args: Txt2TexArgs):
    return execute_agent("txt2tex", "txt2tex", args.model, args.input_file, **args.dict())


class Paper2NoteArgs(SharedArgs):
    sample_chapters: Optional[str] = None
    sample_paper: Optional[str] = None
    sample_note: Optional[str] = None


@router.post("/paper2note")
async def paper2note(args: Paper2NoteArgs):
    return execute_agent("paper2note", "paper2note", args.model, args.input_file, **args.dict())


class AdaptArgs(SharedArgs):
    sample_tex: str
    document_cls: Optional[str] = "lecture.cls"
    commands_file: Optional[str] = "command.tex"


@router.post("/adapt")
async def adapt(args: AdaptArgs):
    return execute_agent("adapt", "adapt", args.model, args.input_file, **args.dict())


@router.post("/correct_prl")
async def correct_prl(args: SharedArgs):
    return execute_agent("edit_prl", "correct_prl", args.model, args.input_file, **args.dict())


@router.post("/polish_prl")
async def polish_prl(args: SharedArgs):
    return execute_agent("edit_prl", "polish_prl", args.model, args.input_file, **args.dict())


@router.post("/correct_supp_prl")
async def correct_supp_prl(args: SharedArgs):
    return execute_agent("edit_prl", "correct_supp_prl", args.model, args.input_file, **args.dict())


class ReplyLetterPRLArgs(SharedArgs):
    supp_file: str = "supp.tex"


@router.post("/reply_letter_prl")
async def reply_letter_prl(args: ReplyLetterPRLArgs):
    _, _, prompt_dir = get_common_env(args.model)
    return execute_agent(
        "rebuttal_prl",
        "reply_letter",
        args.model,
        args.input_file,
        cover_letter="rebuttal/cover_letter.txt",
        instruction="rebuttal/instruction.txt",
        editor_letter="rebuttal/editor_letter.txt",
        report_a="rebuttal/report_a.txt",
        report_b="rebuttal/report_b.txt",
        example_rebuttal_letter=f"{prompt_dir}/prl/example_rebuttal_letter.txt",
        **args.dict(),
    )


class ReviseMainPRLArgs(SharedArgs):
    supp_file: str = "supp.tex"
    draft_reply_letter: Optional[str] = None


@router.post("/revise_main_prl")
async def revise_main_prl(args: ReviseMainPRLArgs):
    _, _, prompt_dir = get_common_env(args.model)
    return execute_agent(
        "rebuttal_prl",
        "revise_main",
        args.model,
        args.input_file,
        cover_letter="rebuttal/cover_letter.txt",
        instruction="rebuttal/instruction.txt",
        editor_letter="rebuttal/editor_letter.txt",
        report_a="rebuttal/report_a.txt",
        report_b="rebuttal/report_b.txt",
        example_rebuttal_letter=f"{prompt_dir}/prl/example_rebuttal_letter.txt",
        **args.dict(),
    )


class ReviseSuppPRLArgs(SharedArgs):
    main_content: str
    draft_reply_letter: str
    draft_main_content: str
    supp_file: str = "supp.tex"


@router.post("/revise_supp_prl")
async def revise_supp_prl(args: ReviseSuppPRLArgs):
    _, _, prompt_dir = get_common_env(args.model)
    return execute_agent(
        "rebuttal_prl",
        "revise_supp",
        args.model,
        args.input_file,
        cover_letter="rebuttal/cover_letter.txt",
        instruction="rebuttal/instruction.txt",
        editor_letter="rebuttal/editor_letter.txt",
        report_a="rebuttal/report_a.txt",
        report_b="rebuttal/report_b.txt",
        example_rebuttal_letter=f"{prompt_dir}/prl/example_rebuttal_letter.txt",
        **args.dict(),
    )


class PolishReplyPRLArgs(SharedArgs):
    main_content: str
    supp_file: str = "supp.tex"


@router.post("/polish_reply_prl")
async def polish_reply_prl(args: PolishReplyPRLArgs):
    _, _, prompt_dir = get_common_env(args.model)
    return execute_agent(
        "rebuttal_prl",
        "polish_reply",
        args.model,
        args.input_file,
        draft_reply_letter=args.input_file,
        cover_letter="rebuttal/cover_letter.txt",
        instruction="rebuttal/instruction.txt",
        editor_letter="rebuttal/editor_letter.txt",
        report_a="rebuttal/report_a.txt",
        report_b="rebuttal/report_b.txt",
        example_rebuttal_letter=f"{prompt_dir}/prl/example_rebuttal_letter.txt",
        **args.dict(),
    )


class MergeArgs(BaseModel):
    model: Optional[str] = "sonnet+"
    input_file: str
    edited_file: str
    reflect: bool = False


@router.post("/merge")
async def merge(args: MergeArgs):
    model, script_dir, _ = get_common_env(args.model)
    command = [
        "python",
        f"{script_dir}/agents/merge.py",
        f"--input_file={args.input_file}",
        f"--edited_file={args.edited_file}",
        f"--model={model}",
    ]
    if args.reflect:
        command.append("--reflect=True")
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode != 0:
        raise HTTPException(status_code=500, detail=f"Merge operation failed: {result.stderr}")
    return result.stdout


@router.post("/paper2cover")
async def paper2cover(args: SharedArgs):
    return execute_agent("write_tex", "paper2cover", args.model, args.input_file, **args.dict())


@router.post("/paper2poster")
async def paper2poster(args: SharedArgs):
    return execute_agent("write_tex", "paper2poster", args.model, args.input_file, **args.dict())


@router.post("/write_proposal")
async def write_proposal(args: SharedArgs):
    return execute_agent("write_tex", "proposal", args.model, args.input_file, **args.dict())


@router.post("/slide2paper")
async def slide2paper(args: SharedArgs):
    return execute_agent("write_tex", "slide2paper", args.model, args.input_file, **args.dict())


@router.post("/paper2slide")
async def paper2slide(args: SharedArgs):
    return execute_agent("write_tex", "paper2slide", args.model, args.input_file, **args.dict())


@router.post("/clean_output")
async def clean_output():
    run_clean_output()
    return {"message": "Output cleaned successfully"}


@router.post("/clean_build")
async def clean_build():
    run_clean_build()
    return {"message": "Build cleaned successfully"}


@router.post("/indent_tex")
async def indent_tex():
    run_indent_tex()
    return {"message": "LaTeX files indented successfully"}


class CleanSingleArgs(BaseModel):
    model: Optional[str] = "sonnet+"
    input_file: str
    agent: str


@router.post("/clean_single")
async def clean_single(args: CleanSingleArgs):
    run_clean_single(args.model, args.input_file, args.agent)
    return {"message": "Single file cleaned successfully"}


class PackSingleArgs(BaseModel):
    model: Optional[str] = "sonnet+"
    input_file: str
    agent: str
    output_name_override: Optional[str] = None


@router.post("/pack_single")
async def pack_single(args: PackSingleArgs):
    run_pack_single(args.model, args.input_file, args.agent, args.output_name_override)
    return {"message": "Single file packed successfully"}


class CleanMultipleArgs(BaseModel):
    model: Optional[str] = "sonnet+"
    input_file: str
    input_files: List[str]
    agent: str


@router.post("/clean_multiple")
async def clean_multiple(args: CleanMultipleArgs):
    run_clean_multiple(args.model, args.input_file, args.input_files, args.agent)
    return {"message": "Multiple files cleaned successfully"}


class PackMultipleArgs(BaseModel):
    model: Optional[str] = "sonnet+"
    input_file: str
    input_files: List[str]
    agent: str
    output_name_override: Optional[str] = None


@router.post("/pack_multiple")
async def pack_multiple(args: PackMultipleArgs):
    run_pack_multiple(args.model, args.input_file, args.input_files, args.agent, args.output_name_override)
    return {"message": "Multiple files packed successfully"}


class LatexdiffArgs(BaseModel):
    input_file: str
    edited_file: str


@router.post("/latexdiff")
async def latexdiff(args: LatexdiffArgs):
    run_latexdiff(args.input_file, args.edited_file)
    return {"message": "Latexdiff completed successfully"}


class LatexdiffVcArgs(BaseModel):
    input_file: str
    commit_hash: str


@router.post("/latexdiff_vc")
async def latexdiff_vc(args: LatexdiffVcArgs):
    run_latexdiff_vc(args.input_file, args.commit_hash)
    return {"message": "Latexdiff-vc completed successfully"}


class LatexdiffVcMultipleArgs(BaseModel):
    input_files: List[str]
    commit_hash: str


@router.post("/latexdiff_vc_multiple")
async def latexdiff_vc_multiple(args: LatexdiffVcMultipleArgs):
    run_latexdiff_vc_multiple(args.input_files, args.commit_hash)
    return {"message": "Latexdiff-vc for multiple files completed successfully"}


class PackLatexdiffVcArgs(BaseModel):
    input_file: str
    commit_hash: str
    clean: bool = False


@router.post("/pack_latexdiff_vc")
async def pack_latexdiff_vc(args: PackLatexdiffVcArgs):
    run_pack_latexdiff_vc(args.input_file, args.commit_hash, args.clean)
    return {"message": "Latexdiff-vc packed successfully"}


class PackLatexdiffVcMultipleArgs(BaseModel):
    input_files: List[str]
    commit_hash: str
    clean: bool = False


@router.post("/pack_latexdiff_vc_multiple")
async def pack_latexdiff_vc_multiple(args: PackLatexdiffVcMultipleArgs):
    run_pack_latexdiff_vc_multiple(args.input_files, args.commit_hash, args.clean)
    return {"message": "Latexdiff-vc for multiple files packed successfully"}


@router.get("/tex_count")
async def tex_count(latex_file: str = Query(..., description="Path to the LaTeX file")):
    stats = get_tex_count(latex_file)
    if stats is not None:
        return {"file": latex_file, "statistics": stats}
    else:
        raise HTTPException(status_code=404, detail="Unable to get statistics for the file")


@router.get("/extract_figure_path")
async def extract_figure_path(latex_file: str = Query(..., description="Path to the LaTeX file")):
    figure_paths = extract_figure_paths(latex_file)
    return {"file": latex_file, "figure_paths": figure_paths}


@router.get("/extract_tikzpictures")
async def extract_tikzpictures(latex_file: str = Query(..., description="Path to the LaTeX file")):
    compiled_files = extract_and_compile_tikzpictures_with_labels(latex_file)
    return {"file": latex_file, "compiled_tikz_files": compiled_files}


class StatementArgs(SharedArgs):
    document_type: Optional[str] = Query(
        None, description="Type of document being revised", enum=["research", "teaching", "diversity", "cover_letter"]
    )


@router.post("/statement")
async def statement(args: StatementArgs):
    agent_sub = args.document_type
    if agent_sub is None:
        if "teaching" in args.input_file.lower():
            agent_sub = "teaching"
        elif "diversity" in args.input_file.lower():
            agent_sub = "diversity"
        elif "research" in args.input_file.lower():
            agent_sub = "research"
        else:
            raise HTTPException(status_code=400, detail="Document type not recognized")

    return execute_agent("application", f"statement_{agent_sub}", args.model, args.input_file, **args.dict())


@router.post("/revise_nsf_grant")
async def revise_nsf_grant(args: SharedArgs):
    return execute_agent("grant", "revise_nsf_grant", args.model, args.input_file, **args.dict())


@router.post("/revise_marie_curie")
async def revise_marie_curie(args: SharedArgs):
    return execute_agent("grant", "revise_marie_curie", args.model, args.input_file, **args.dict())


@router.post("/text2tex")
async def text2tex(args: SharedArgs):
    agent_sub = "text2tex"
    if ".tex" in args.input_file:
        agent_sub = "text2tex_draft"
    return execute_agent("meeting2text", agent_sub, args.model, args.input_file, **args.dict())


@router.post("/revise_prl")
async def revise_prl(args: SharedArgs):
    _, _, prompt_dir = get_common_env(args.model)
    return execute_agent(
        "rebuttal_prl",
        "revise_prl",
        args.model,
        args.input_file,
        supp_file="supp.tex",
        cover_letter="replies/cover_letter.txt",
        editor_letter="replies/editor_letter.txt",
        report_a="replies/report_a.txt",
        report_b="replies/report_b.txt",
        example_rebuttal_letter="replies/reply_to_referees.tex",
        draft_reply_letter="replies/reply_to_referees.tex",
        **args.dict(),
    )


@router.post("/draft_rebuttal_prl")
async def draft_rebuttal_prl(args: SharedArgs):
    return execute_agent("rebuttal_prl", "draft_rebuttal", args.model, args.input_file, **args.dict())


@router.post("/revise_rebuttal_prl")
async def revise_rebuttal_prl(args: SharedArgs):
    return execute_agent("rebuttal_prl", "revise_rebuttal", args.model, args.input_file, **args.dict())


@router.post("/paper2referee")
async def paper2referee(args: SharedArgs):
    return execute_agent("write_tex", "paper2referee", args.model, args.input_file, **args.dict())


@router.post("/revise_referee")
async def revise_referee(args: SharedArgs):
    return execute_agent("write_tex", "revise_referee", args.model, args.input_file, **args.dict())


@router.post("/convert_tex")
async def convert_tex(args: SharedArgs):
    agent = "convert"
    if args.output_files:
        agent = f"{agent}_multiple"
    elif args.auxiliary_files:
        agent = f"{agent}_with_auxiliary"
    return execute_agent("edit_tex", agent, args.model, args.input_file, **args.dict())
