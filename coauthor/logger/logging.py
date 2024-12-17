import logging
import colorlog
import sys


def setup_logger(name: str = "coauthor") -> logging.Logger:
    """Set up a colored logger instance."""
    logger = colorlog.getLogger(name)

    if not logger.handlers:  # Avoid adding handlers multiple times
        handler = colorlog.StreamHandler(sys.stdout)
        handler.setFormatter(
            colorlog.ColoredFormatter(
                "[%(asctime)s] %(log_color)s%(levelname)-8s%(reset)s %(message_log_color)s%(message)s",
                log_colors={
                    "DEBUG": "blue",
                    "INFO": "green",
                    "WARNING": "yellow",
                    "ERROR": "red",
                    "CRITICAL": "red,bg_white",
                },
                secondary_log_colors={"message": {"DEBUG": "cyan", "INFO": "white", "WARNING": "yellow", "ERROR": "red", "CRITICAL": "red"}},
                datefmt="%H:%M:%S",
            )
        )

        logger.addHandler(handler)
        logger.setLevel(logging.DEBUG)  # Changed from INFO to DEBUG to show debug messages

    return logger


# Create a default logger instance
logger = setup_logger()
