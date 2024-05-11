SCRIPT_DIR="/Users/siruilu/Local/AI-Projects/coauthor"
PROMPT_PATH=$SCRIPT_DIR/prompts
MODEL=opus


alias correct='python "$SCRIPT_DIR/correct_lectures.py" --task=correct --model=$MODEL'

alias correct_qi='python "$SCRIPT_DIR/correct_lectures.py" --task=correct_qi --model=$MODEL'

alias correct_st='python $SCRIPT_DIR/correct_lectures.py --task=correct_st --model=$MODEL'


