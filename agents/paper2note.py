from coauthor.agent_reflect import DirectWrite
import coauthor as coa

agent_path = coa.get_agent_path(coa, "paper2note")


def main():
    parser = coa.get_common_argparser()
    parser.add_argument(
        "--agent",
        type=str,
        default="paper2note",
        help="Agent to choose, either 'paper2note' or 'paper2note_example'.",
        choices=["paper2note", "paper2note_example"],
    )
    args = parser.parse_args()

    agent = DirectWrite(args, agent_path)
    agent.run()


if __name__ == "__main__":
    main()
