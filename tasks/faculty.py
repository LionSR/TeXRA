from coauthor.base_tasks import ThinkWrite
import coauthor as coa

prompt_path = coa.get_prompt_path(coa, "faculty")


class ReviseApplicationDocument(ThinkWrite):
    def get_user_vars(self):
        user_vars = coa.get_user_vars_basic(self.args)

        if self.args.original_file:
            user_vars["INPUT_CONTENT"] = coa.read_file(self.args.original_file)

        coa.update_user_vars_single_output(self.args, user_vars)
        return user_vars

    # The handle_output method is inherited from ThinkWrite


def main():
    parser = coa.get_common_argparser()
    parser.add_argument("--task", type=str, choices=["statement_teaching", "statement_diversity", "statement_research"])
    parser.add_argument("--original_file", type=str, help="Path to the original application document file")
    args = parser.parse_args()

    revise_document = ReviseApplicationDocument(args, prompt_path)
    revise_document.run()


if __name__ == "__main__":
    main()
