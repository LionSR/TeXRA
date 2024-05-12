SCRIPT_DIR="/Users/siruilu/Local/AI-Projects/coauthor"

function correct_article() {
    local MODEL=${MODEL:-opus}
    local INPUT_FILE=$1
    export PROMPT_PATH="$SCRIPT_DIR/prompts"
    python "$SCRIPT_DIR/correct_article.py" --task=correct_main --model=$MODEL --prompt_path=$PROMPT_PATH "$INPUT_FILE"
}

function correct_prl_supp() {
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
