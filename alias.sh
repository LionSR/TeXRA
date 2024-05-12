SCRIPT_DIR="/Users/siruilu/Local/AI-Projects/coauthor"
export PROMPT_PATH="$SCRIPT_DIR/prompts"

function correct_article() {
    local MODEL=${MODEL:-opus}
    local INPUT_FILE=$1
    python "$SCRIPT_DIR/correct_lectures.py" --task=correct --model=$MODEL --prompt_path=$PROMPT_PATH "$INPUT_FILE"
}

function correct_qi() {
    local MODEL=${MODEL:-opus}
    local INPUT_FILE=$1
    python "$SCRIPT_DIR/correct_lectures.py" --task=correct_qi --model=$MODEL --prompt_path=$PROMPT_PATH "$INPUT_FILE"
}

function correct_st() {
    local MODEL=${MODEL:-opus}
    local INPUT_FILE=$1
    python "$SCRIPT_DIR/correct_lectures.py" --task=correct_st --model=$MODEL --prompt_path=$PROMPT_PATH "$INPUT_FILE"
}
