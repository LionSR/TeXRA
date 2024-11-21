import coauthor as coa
from coauthor.agent_reflect import ThinkAndWrite, DirectWrite

agent_path = coa.get_agent_path(coa, "lecture")


def main():
    parser = coa.get_common_argparser()
    parser.add_argument(
        "--agent",
        type=str,
        default="correct_st",
        choices=[
            "correct_qi",
            "correct_st",
            "correct_st_multiple",
            "polish_qi",
            "polish_st",
            "polish_st_multiple",
            "draw_qi",
            "draw_st",
            "draw_st_multiple",
            "revise_st",
            "revise_st_multiple",
        ],
    )
    args = parser.parse_args()

    if args.agent.startswith("correct"):
        edit_lecture = DirectWrite(args, agent_path)
    else:
        edit_lecture = ThinkAndWrite(args, agent_path)
    edit_lecture.run()


if __name__ == "__main__":
    main()
