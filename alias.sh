MODEL=opus
SCRIPT_DIR="/Users/siruilu/Local/AI-Projects/coauthor"
export PROMPT_PATH="$SCRIPT_DIR/prompts"

alias correct='python "$SCRIPT_DIR/correct_lectures.py" --task=correct --model=$MODEL --prompt_path=$PROMPT_PATH'

alias correct_qi='python "$SCRIPT_DIR/correct_lectures.py" --task=correct_qi --model=$MODEL --prompt_path=$PROMPT_PATH'

alias correct_st='python "$SCRIPT_DIR/correct_lectures.py" --task=correct_st --model=$MODEL --prompt_path=$PROMPT_PATH'


