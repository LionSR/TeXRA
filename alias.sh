export SCRIPT_DIR="/Users/siruilu/Local/AI-Projects/coauthor"
export PROMPT_DIR="$SCRIPT_DIR/prompts"

# general

function correct_article() {
    local MODEL=${MODEL:-opus}
    local INPUT_FILE=$1
    local AUXILIARY_FILE=$2
    export PROMPT_PATH="$PROMPT_DIR/general"
    python "$SCRIPT_DIR/correct_article.py" --task=correct_article --model=$MODEL --prompt_path=$PROMPT_PATH --auxiliary_file="$AUXILIARY_FILE" --input_file="${INPUT_FILE}"
}

function correct_main() {
    local MODEL=${MODEL:-opus}
    local INPUT_FILE=$1
    export PROMPT_PATH="$PROMPT_DIR/general"
    python "$SCRIPT_DIR/correct_article.py" --task=correct_main --model=$MODEL --prompt_path=$PROMPT_PATH --input_file="${INPUT_FILE}"
}

# meeting2text

function meeting2text() {
    local INPUT_FILE=$1
    local CONTEXT_FILE=$2
    local EXAMPLE_TRANSCRIPT=${3:-""}
    local EXAMPLE_EDITED_TRANSCRIPT=${4:-""}
    local PROMPT_PATH="$PROMPT_DIR/meeting2text"
    local MODEL=${MODEL:-opus}
    # local MODEL=${MODEL:-sonnet}
    python "${SCRIPT_DIR}/meeting2text.py" --task=transcribe --input_file="${INPUT_FILE}" --model="${MODEL}" --prompt_path="${PROMPT_PATH}" --context_file="${CONTEXT_FILE}" --example_transcript="${EXAMPLE_TRANSCRIPT}" --example_edited_transcript="${EXAMPLE_EDITED_TRANSCRIPT}"
}

# paper2note

function paper2note() {
    local INPUT_FILE=$1
    local SAMPLE_CHAPTERS=$2
    local SAMPLE_PAPER=$3
    local SAMPLE_NOTE=$4
    local PROMPT_PATH="$PROMPT_DIR/paper2note"
    # local MODEL=${MODEL:-opus}
    # local MODEL=${MODEL:-sonnet}
    python "${SCRIPT_DIR}/paper2note.py" --model=${MODEL} --prompt_path=${PROMPT_PATH} --task=paper2note --input_file="${INPUT_FILE}" --sample_chapters="${SAMPLE_CHAPTERS}" --sample_paper="${SAMPLE_PAPER}" --sample_note="${SAMPLE_NOTE}"
}

# txt2tex

function txt2tex() {
    local INPUT_FILE=$1
    local DOCUMENT_CLS=${2:-"lecture.cls"}
    local COMMANDS_FILE=${3:-"command.tex"}
    local SAMPLE_TEX=${4:-""}
    local PROMPT_PATH="$PROMPT_DIR/txt2tex"
    local MODEL=${MODEL:-opus}
    python "${SCRIPT_DIR}/txt2tex.py" --model=${MODEL} --prompt_path=${PROMPT_PATH} --task=txt2tex --input_file="${INPUT_FILE}" --sample_tex="${SAMPLE_TEX}" --document_cls="${DOCUMENT_CLS}" --commands_file="${COMMANDS_FILE}"
}


# prl_edit

function correct_supp_prl() {
    local MODEL=${MODEL:-opus}
    local INPUT_FILE=$1
    local AUXILIARY_FILE=$2
    export PROMPT_PATH="$SCRIPT_DIR/prl_edit"
    python "$SCRIPT_DIR/edit_prl.py" --task=correct_supp_prl --model=$MODEL --prompt_path=$PROMPT_PATH --auxiliary_file="$AUXILIARY_FILE" --input_file="${INPUT_FILE}"
}

function correct_prl() {
    local MODEL=${MODEL:-opus}
    local INPUT_FILE=$1
    export PROMPT_PATH="$PROMPT_DIR/prl_edit"
    python "$SCRIPT_DIR/edit_prl.py" --task=correct_prl --model=$MODEL --prompt_path=$PROMPT_PATH --input_file="${INPUT_FILE}"
}

# correct_lecture

function correct_qi() {
    local MODEL=${MODEL:-opus}
    local INPUT_FILE=$1
    export PROMPT_PATH="$PROMPT_DIR/lecture_qi"
    python "$SCRIPT_DIR/correct_lectures.py" --task=correct_qi --model=$MODEL --prompt_path=$PROMPT_PATH --input_file="${INPUT_FILE}"
}

function correct_st() {
    local MODEL=${MODEL:-opus}
    local INPUT_FILE=$1
    export PROMPT_PATH="$PROMPT_DIR/lecture_st"
    python "$SCRIPT_DIR/correct_lectures.py" --task=correct_st --model=$MODEL --prompt_path=$PROMPT_PATH --input_file="${INPUT_FILE}"
}


# prl_reply

function reply_letter_prl() {
    local INPUT_FILE=${1}
    local SUPP_FILE=${2:-"supp.tex"}
    export PROMPT_PATH="$PROMPT_DIR/prl_reply"
    local MODEL=${MODEL:-opus}
    python "${SCRIPT_DIR}/prl_reply.py" --model=${MODEL} --prompt_path=${PROMPT_PATH} --example_reply_letter="${PROMPT_PATH}/example_reply_letter.txt" --task=reply_letter --input_file="${INPUT_FILE}" --supp_file="${SUPP_FILE}" --cover_letter=rebuttal/cover_letter.txt --instruction=rebuttal/instruction.txt --editor_letter=rebuttal/editor_letter.txt --report_a=rebuttal/report_a.txt --report_b=rebuttal/report_b.txt
}

function revise_main_prl() {
    local INPUT_FILE=$1
    local SUPP_FILE=${2:-"supp.tex"}
    local DRAFT_REPLY_LETTER=$3
    export PROMPT_PATH="$PROMPT_DIR/prl_reply"
    local MODEL=${MODEL:-opus}
    python "${SCRIPT_DIR}/prl_reply.py" --model=${MODEL} --prompt_path=${PROMPT_PATH} --example_reply_letter="${PROMPT_PATH}/example_reply_letter.txt" --task=revise_main --input_file="${INPUT_FILE}" --supp_file="${SUPP_FILE}" --draft_reply_letter="${DRAFT_REPLY_LETTER}" --cover_letter=rebuttal/cover_letter.txt --instruction=rebuttal/instruction.txt --editor_letter=rebuttal/editor_letter.txt --report_a=rebuttal/report_a.txt --report_b=rebuttal/report_b.txt
}

function revise_supp_prl() {
    local INPUT_FILE=$1
    local MAIN_CONTENT=$2
    local DRAFT_REPLY_LETTER=$3
    local DRAFT_MAIN_CONTENT=$4
    local SUPP_FILE=${5:-"supp.tex"}
    export PROMPT_PATH="$PROMPT_DIR/prl_reply"
    local MODEL=${MODEL:-opus}
    python "${SCRIPT_DIR}/prl_reply.py" --model=${MODEL} --prompt_path=${PROMPT_PATH} --example_reply_letter="${PROMPT_PATH}/example_reply_letter.txt" --task=revise_supp --input_file="${INPUT_FILE}" --main_content="${MAIN_CONTENT}" --supp_file="${SUPP_FILE}" --draft_reply_letter="${DRAFT_REPLY_LETTER}" --draft_main_content="${DRAFT_MAIN_CONTENT}" --cover_letter=rebuttal/cover_letter.txt --instruction=rebuttal/instruction.txt --editor_letter=rebuttal/editor_letter.txt --report_a=rebuttal/report_a.txt --report_b=rebuttal/report_b.txt
}


function polish_prl_reply() {
    local INPUT_FILE=$1
    local MAIN_CONTENT=$2
    local SUPP_FILE=${3:-"supp.tex"}
    local DRAFT_REPLY_LETTER=$1
    export PROMPT_PATH="$PROMPT_DIR/prl_reply"
    local MODEL=${MODEL:-opus}
    python "${SCRIPT_DIR}/prl_reply.py" --model=${MODEL} --prompt_path=${PROMPT_PATH} --example_reply_letter="${PROMPT_PATH}/example_reply_letter.txt" --task=polish_reply --input_file="${INPUT_FILE}" --main_content="${MAIN_CONTENT}" --supp_file="${SUPP_FILE}" --draft_reply_letter="${DRAFT_REPLY_LETTER}" --cover_letter=rebuttal/cover_letter.txt --instruction=rebuttal/instruction.txt --editor_letter=rebuttal/editor_letter.txt --report_a=rebuttal/report_a.txt --report_b=rebuttal/report_b.txt
}

# adapt

function adapt() {
    local INPUT_FILE=$1
    local SAMPLE_TEX=$2
    local DOCUMENT_CLS=${3:-"lecture.cls"}
    local COMMANDS_FILE=${4:-"command.tex"}
    local PROMPT_PATH="$PROMPT_DIR/adapt"
    local MODEL=${MODEL:-opus}
    python "${SCRIPT_DIR}/adapt.py" --model=${MODEL} --prompt_path=${PROMPT_PATH} --task=adapt --input_file="${INPUT_FILE}" --sample_tex="${SAMPLE_TEX}" --document_cls="${DOCUMENT_CLS}" --commands_file="${COMMANDS_FILE}"
}