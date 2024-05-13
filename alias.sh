SCRIPT_DIR="/Users/siruilu/Local/AI-Projects/coauthor"

function correct_article() {
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
    python "$SCRIPT_DIR/correct_prl.py" --task=correct_prl_supp --model=$MODEL --prompt_path=$PROMPT_PATH --auxiliary_file="$AUXILIARY_FILE" "$INPUT_FILE" 
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
    local MODEL=${MODEL:-opus}
    local INPUT_FILE=$1
    local SUPP_FILE=${2:-"supp.tex"}
    local REBUTTAL_PATH="rebuttal"
    local INSTRUCTION="$REBUTTAL_PATH/instruction.txt"
    local COVER_LETTER="$REBUTTAL_PATH/cover_letter.txt"
    local EDITOR_LETTER="$REBUTTAL_PATH/editor_letter.txt"
    local REPORT_A="$REBUTTAL_PATH/report_a.txt"
    local REPORT_B="$REBUTTAL_PATH/report_b.txt"
    export PROMPT_PATH="$SCRIPT_DIR/prompts_reply"
    python "$SCRIPT_DIR/reply_prl.py" --task=reply_letter --model=$MODEL --prompt_path=$PROMPT_PATH  --supp_file="$SUPP_FILE" --referee_reports="$REFEREE_REPORTS" --instruction="$INSTRUCTION" --cover_letter="$COVER_LETTER" --editor_letter="$EDITOR_LETTER" --report_a="$REPORT_A" --report_b="$REPORT_B" "$INPUT_FILE"
}

function revised_paper_prl() {
    local MODEL=${MODEL:-opus}
    local INPUT_FILE=$1
    local DRAFT_REPLY_LETTER=${2:-""}
    local SUPP_FILE=${3:-"supp.tex"}
    local REBUTTAL_PATH="rebuttal"
    local INSTRUCTION="$REBUTTAL_PATH/instruction.txt"
    local COVER_LETTER="$REBUTTAL_PATH/cover_letter.txt"
    local EDITOR_LETTER="$REBUTTAL_PATH/editor_letter.txt"
    local REPORT_A="$REBUTTAL_PATH/report_a.txt"
    local REPORT_B="$REBUTTAL_PATH/report_b.txt"
    export PROMPT_PATH="$SCRIPT_DIR/prompts_reply"
    python "$SCRIPT_DIR/reply_prl.py" --task=revised_paper --model=$MODEL --prompt_path=$PROMPT_PATH  --supp_file="$SUPP_FILE" --referee_reports="$REFEREE_REPORTS" --instruction="$INSTRUCTION" --cover_letter="$COVER_LETTER" --editor_letter="$EDITOR_LETTER" --report_a="$REPORT_A" --report_b="$REPORT_B" --draft_reply_letter="$DRAFT_REPLY_LETTER" "$INPUT_FILE"
}