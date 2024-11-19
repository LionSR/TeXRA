from coauthor.agent_reflect import ThinkAndWrite
import coauthor as coa

agent_path = coa.get_agent_path(coa, "application")


class ReviseApplicationDocument(ThinkAndWrite):
    def get_user_vars(self):
        user_vars = super().get_user_vars()
        return user_vars


def main():
    parser = coa.get_common_argparser()
    parser.add_argument(
        "--agent",
        type=str,
        default="statement_teaching",
        choices=["statement_teaching", "statement_diversity", "statement_research"],
    )
    args = parser.parse_args()

    revise_document = ReviseApplicationDocument(args, agent_path)
    revise_document.run()


if __name__ == "__main__":
    main()
