from coauthor.agent_reflect import DirectWrite
import coauthor as coa

agent_path = coa.get_agent_path(coa, "txt2tex")


class Txt2Tex(DirectWrite):
    def get_user_vars(self):
        user_vars = super().get_user_vars()
        return user_vars


def main():
    parser = coa.get_common_argparser()
    parser.add_argument(
        "--agent", type=str, default="txt2tex", choices=["txt2tex", "txt2tex_article", "txt2tex_paper", "txt2tex_example"], help="Agents to choose."
    )
    args = parser.parse_args()

    agent = Txt2Tex(args, agent_path)
    agent.run()


if __name__ == "__main__":
    main()
