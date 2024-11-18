from coauthor.agent_reflect import ThinkAndWrite, DirectWrite
import coauthor as coa

agent_path = coa.get_agent_path(coa, "article")


class EditTexBase:
    def get_user_vars(self):
        user_vars = super().get_user_vars()

        if self.args.agent == "convert":
            if "iclr" in self.args.input_file:
                user_vars["ICLR_TEMPLATE"] = coa.read_file(self.args.input_file)
            if "neurips" in self.args.input_file:
                user_vars["NeurIPS_TEX"] = coa.read_file(self.args.input_file)
            for file in self.args.input_files:
                if "iclr" in file.lower():
                    user_vars["ICLR_TEMPLATE"] = coa.read_file(file)
                if "neurips" in file.lower():
                    user_vars["NeurIPS_TEX"] = coa.read_file(file)
        elif self.args.agent == "ocr":
            # OCR-specific variables will be handled by the image processing pipeline
            user_vars["IMAGE_CONTENT"] = ""  # Placeholder, will be populated externally
            user_vars["INSERTION_LOCATION"] = self.args.insertion_point if hasattr(self.args, "insertion_point") else ""
        return user_vars


class EditTexThink(EditTexBase, ThinkAndWrite):
    pass


class EditTexDirect(EditTexBase, DirectWrite):
    pass


def main():
    parser = coa.get_common_argparser()
    parser.add_argument(
        "--agent",
        type=str,
        default="correct",
        choices=[
            "correct",
            "polish",
            "draw",
            "correct_multiple",
            "polish_multiple",
            "draw_multiple",
            "convert",
            "ocr",
        ],
    )

    args = parser.parse_args()

    # OCR agent should use ThinkAndWrite to analyze notation and ensure consistency
    if args.agent.startswith("correct"):
        edit_tex = EditTexDirect(args, agent_path)
    else:
        edit_tex = EditTexThink(args, agent_path)
    edit_tex.run()


if __name__ == "__main__":
    main()
