from ..agent.model_registry import MODEL_CONFIGS

EXCLUDED_DIRS = ["Figs", "Figures", "build", "Versions", "versions", "History", "history", "figs", "figures", "Notes"]
PACK_EXTENSIONS = [".pdf", ".tex", ".txt", ".text", ".xml", ".md"]
TEMP_EXTENSIONS = [
    ".pdf",
    ".aux",
    ".bbl",
    ".blg",
    ".fdb_latexmk",
    ".fls",
    ".log",
    ".out",
    ".synctex.gz",
    ".bib",
    ".nav",
    ".run.xml",
    ".snm",
    ".toc",
    "-blx.bib",
    "Notes.bib",
]
MODELS = list(MODEL_CONFIGS.keys())
HISTORY_DIR = "History"
