export SCRIPT_DIR="/Users/siruilu/Local/AI-Projects/coauthor"


function correct_article() {
    local MODEL=${MODEL:-opus}
    local INPUT_FILE=$1
    local AUXILIARY_FILE=$2
    export PROMPT_PATH="$SCRIPT_DIR/prompts"
    python "$SCRIPT_DIR/correct_article.py" --task=correct_article --model=$MODEL --prompt_path=$PROMPT_PATH --auxiliary_file="$AUXILIARY_FILE" "$INPUT_FILE"
}

function correct_main() {
    local MODEL=${MODEL:-opus}
    local INPUT_FILE=$1
    export PROMPT_PATH="$SCRIPT_DIR/prompts"
    python "$SCRIPT_DIR/correct_article.py" --task=correct_main --model=$MODEL --prompt_path=$PROMPT_PATH "$INPUT_FILE"
}

function correct_supp_prl() {
    local MODEL=${MODEL:-opus}
    local INPUT_FILE=$1
    local AUXILIARY_FILE=$2
    export PROMPT_PATH="$SCRIPT_DIR/prompts_prl"
    python "$SCRIPT_DIR/correct_prl.py" --task=correct_supp_prl --model=$MODEL --prompt_path=$PROMPT_PATH --auxiliary_file="$AUXILIARY_FILE" "$INPUT_FILE" 
}


function correct_prl() {
    local MODEL=${MODEL:-opus}
    local INPUT_FILE=$1
    export PROMPT_PATH="$SCRIPT_DIR/prompts_prl"
    python "$SCRIPT_DIR/correct_prl.py" --task=correct_prl --model=$MODEL --prompt_path=$PROMPT_PATH "$INPUT_FILE"
}

function correct_qi() {
    local MODEL=${MODEL:-opus}
    local INPUT_FILE=$1
    export PROMPT_PATH="$SCRIPT_DIR/prompts_qi"
    python "$SCRIPT_DIR/correct_lectures.py" --task=correct_qi --model=$MODEL --prompt_path=$PROMPT_PATH "$INPUT_FILE"
}

function correct_st() {
    local MODEL=${MODEL:-opus}
    local INPUT_FILE=$1
    export PROMPT_PATH="$SCRIPT_DIR/prompts_st"
    python "$SCRIPT_DIR/correct_lectures.py" --task=correct_st --model=$MODEL --prompt_path=$PROMPT_PATH "$INPUT_FILE"
}


function reply_letter_prl() {
    local INPUT_FILE=${1}
    local SUPP_FILE=${2:-"supp.tex"}
    local PROMPT_PATH=${SCRIPT_DIR}/prompts_reply
    local MODEL=${MODEL:-opus}
    python "${SCRIPT_DIR}/reply_prl.py" --model=${MODEL} --prompt_path=${PROMPT_PATH} --example_reply_letter="${PROMPT_PATH}/example_reply_letter.txt" --task=reply_letter --input_file="${INPUT_FILE}" --supp_file="${SUPP_FILE}" --cover_letter=rebuttal/cover_letter.txt --instruction=rebuttal/instruction.txt --editor_letter=rebuttal/editor_letter.txt --report_a=rebuttal/report_a.txt --report_b=rebuttal/report_b.txt
}

function revise_main_prl() {
    local INPUT_FILE=$1
    local SUPP_FILE=${2:-"supp.tex"}
    local DRAFT_REPLY_LETTER=$3
    local PROMPT_PATH=${SCRIPT_DIR}/prompts_reply
    local MODEL=${MODEL:-opus}
    python "${SCRIPT_DIR}/reply_prl.py" --model=${MODEL} --prompt_path=${PROMPT_PATH} --example_reply_letter="${PROMPT_PATH}/example_reply_letter.txt" --task=revise_main --input_file="${INPUT_FILE}" --supp_file="${SUPP_FILE}" --draft_reply_letter="${DRAFT_REPLY_LETTER}" --cover_letter=rebuttal/cover_letter.txt --instruction=rebuttal/instruction.txt --editor_letter=rebuttal/editor_letter.txt --report_a=rebuttal/report_a.txt --report_b=rebuttal/report_b.txt
}

function revise_supp_prl() {
    local INPUT_FILE=$1
    local MAIN_CONTENT=$2
    local DRAFT_REPLY_LETTER=$3
    local DRAFT_MAIN_CONTENT=$4
    local SUPP_FILE=${5:-"supp.tex"}
    local PROMPT_PATH=${SCRIPT_DIR}/prompts_reply
    local MODEL=${MODEL:-opus}
    python "${SCRIPT_DIR}/reply_prl.py" --model=${MODEL} --prompt_path=${PROMPT_PATH} --example_reply_letter="${PROMPT_PATH}/example_reply_letter.txt" --task=revise_supp --input_file="${INPUT_FILE}" --main_content="${MAIN_CONTENT}" --supp_file="${SUPP_FILE}" --draft_reply_letter="${DRAFT_REPLY_LETTER}" --draft_main_content="${DRAFT_MAIN_CONTENT}" --cover_letter=rebuttal/cover_letter.txt --instruction=rebuttal/instruction.txt --editor_letter=rebuttal/editor_letter.txt --report_a=rebuttal/report_a.txt --report_b=rebuttal/report_b.txt
}


function polish_reply_prl() {
    local INPUT_FILE=$1
    local MAIN_CONTENT=$2
    local SUPP_FILE=${3:-"supp.tex"}
    local DRAFT_REPLY_LETTER=$1
    local PROMPT_PATH=${SCRIPT_DIR}/prompts_reply
    local MODEL=${MODEL:-opus}
    python "${SCRIPT_DIR}/reply_prl.py" --model=${MODEL} --prompt_path=${PROMPT_PATH} --example_reply_letter="${PROMPT_PATH}/example_reply_letter.txt" --task=polish_reply --input_file="${INPUT_FILE}" --main_content="${MAIN_CONTENT}" --supp_file="${SUPP_FILE}" --draft_reply_letter="${DRAFT_REPLY_LETTER}" --cover_letter=rebuttal/cover_letter.txt --instruction=rebuttal/instruction.txt --editor_letter=rebuttal/editor_letter.txt --report_a=rebuttal/report_a.txt --report_b=rebuttal/report_b.txt
}
