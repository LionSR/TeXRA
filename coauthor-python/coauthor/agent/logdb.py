import json
import logging
import os
import sqlite3
from datetime import datetime

from .agent_config import AgentConfig
from .agent_dataclass import AgentSetting
from .agent_state import AgentStateGlobal, AgentStateRound


HISTORY_DIR = "History"
logger = logging.getLogger(__name__)


def getDbPath() -> str:
    """Get path to SQLite database in current working directory."""
    if not os.path.exists(HISTORY_DIR):
        os.makedirs(HISTORY_DIR, exist_ok=True)
    return os.path.join(os.getcwd(), f"{HISTORY_DIR}/logs.db")


def initDb() -> None:
    """Initialize SQLite database with a single comprehensive table."""
    db_path = getDbPath()
    try:
        with sqlite3.connect(db_path) as conn:
            c = conn.cursor()
            c.execute(
                """CREATE TABLE IF NOT EXISTS coauthor_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp DATETIME,
                agent TEXT,
                model TEXT,
                temperature FLOAT,
                inputFile TEXT,
                inputFiles TEXT,
                auxiliaryFile TEXT,
                auxiliaryFiles TEXT,
                figureFile TEXT,
                figureFiles TEXT,
                referenceFile TEXT,
                referenceFiles TEXT,
                editedFile TEXT,
                outputFiles TEXT,
                outputNameOverride TEXT,
                actualOutputFiles TEXT,
                outputFile TEXT,
                instruction TEXT,
                toolFlags TEXT,  -- JSON object for all tool flags
                stateGlobal TEXT,  -- JSON object for global metrics
                stateRounds TEXT   -- JSON array of round-specific metrics
            )"""
            )
            conn.commit()
    except sqlite3.Error as e:
        logger.error(f"Database initialization failed: {e}")
        raise


def createLogEntry(agentConfig: AgentConfig, agentSetting: AgentSetting) -> int:
    """Create a new log entry and return its ID."""
    initDb()
    try:
        with sqlite3.connect(getDbPath()) as conn:
            c = conn.cursor()

            inputFiles = json.dumps(agentConfig.inputFiles) if agentConfig.inputFiles else None
            auxiliaryFiles = json.dumps(agentConfig.auxiliaryFiles) if agentConfig.auxiliaryFiles else None
            figureFiles = json.dumps(agentConfig.figureFiles) if agentConfig.figureFiles else None
            referenceFiles = json.dumps(agentConfig.referenceFiles) if agentConfig.referenceFiles else None
            outputFiles = json.dumps(agentConfig.outputFiles) if agentConfig.outputFiles else None
            actualOutputFiles = json.dumps([])

            toolFlags = json.dumps(
                {
                    "reflect": agentConfig.reflect,
                    "autoExtractFigure": agentConfig.toolConfig.autoExtractFigure,
                    "autoExtractTikzFigure": agentConfig.toolConfig.autoExtractTikzFigure,
                    "autoExtractTikzFigureReflect": agentConfig.toolConfig.autoExtractTikzFigureReflect,
                    "attachTeXCount": agentConfig.toolConfig.attachTeXCount,
                    "usePrefillFromInput": agentConfig.toolConfig.usePrefillFromInput,
                    "autoConfirmation": agentConfig.toolConfig.autoConfirmation,
                }
            )

            stateGlobal = json.dumps({})
            stateRounds = json.dumps({})

            c.execute(
                """INSERT INTO coauthor_logs (
                timestamp, agent, model, temperature,
                inputFile, inputFiles, auxiliaryFile, auxiliaryFiles,
                figureFile, figureFiles, referenceFile, referenceFiles,
                editedFile, outputFiles, outputNameOverride,
                actualOutputFiles, instruction,
                toolFlags, stateGlobal, stateRounds
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    datetime.now(),
                    agentConfig.agent,
                    agentConfig.model,
                    agentSetting.temperature,
                    agentConfig.inputFile,
                    inputFiles,
                    agentConfig.auxiliaryFile,
                    auxiliaryFiles,
                    agentConfig.figureFile,
                    figureFiles,
                    agentConfig.referenceFile,
                    referenceFiles,
                    agentConfig.editedFile,
                    outputFiles,
                    agentConfig.outputNameOverride,
                    actualOutputFiles,
                    agentConfig.instruction,
                    toolFlags,
                    stateGlobal,
                    stateRounds,
                ),
            )

            logId = c.lastrowid
            if logId is None:
                raise RuntimeError("Failed to create log entry - no ID returned")

            conn.commit()
            return logId
    except sqlite3.Error as e:
        logger.error(f"Failed to create log entry: {e}")
        raise


def updateLogStatistics(logId: int, stateGlobal: AgentStateGlobal, stateRound: AgentStateRound, round: int) -> None:
    """Update statistics in the database for a specific log entry."""
    if logId is None:
        logger.warning("No log ID provided, skipping statistics update")
        return

    try:
        with sqlite3.connect(getDbPath()) as conn:
            c = conn.cursor()

            # First, get existing round states
            c.execute("SELECT stateRounds FROM coauthor_logs WHERE id = ?", (logId,))
            row = c.fetchone()
            if not row:
                logger.error(f"No log entry found for ID {logId}")
                return

            existing_stateRounds = json.loads(row[0]) if row[0] else {}

            # Update the round states with the new state
            existing_stateRounds[str(round)] = stateRound.to_dict()

            # Get the output file from the current round state
            outputFile = stateRound.outputFile

            # Convert stateGlobal to dict before JSON serialization
            stateGlobal_dict = stateGlobal.to_dict()
            if stateGlobal_dict.get("APIUsage"):
                stateGlobal_dict["APIUsage"] = stateGlobal_dict["APIUsage"].to_dict()

            stateGlobalJson = json.dumps(stateGlobal_dict)
            stateRoundsJson = json.dumps(existing_stateRounds)

            # Update the database
            c.execute(
                """UPDATE coauthor_logs SET
                stateGlobal = ?,
                stateRounds = ?,
                outputFile = ?
                WHERE id = ?""",
                (stateGlobalJson, stateRoundsJson, outputFile, logId),
            )

            conn.commit()
    except sqlite3.Error as e:
        logger.error(f"Failed to update log statistics: {e}")
        raise


def updateLogAndOutputFiles(logId: int, outputFile: str, all_outputFiles: list[str] | None = None) -> None:
    """Update output files for a specific log entry."""
    if logId is None:
        logger.warning("No log ID provided, skipping output files update")
        return

    try:
        with sqlite3.connect(getDbPath()) as conn:
            c = conn.cursor()

            c.execute("SELECT actualOutputFiles FROM coauthor_logs WHERE id = ?", (logId,))
            row = c.fetchone()
            if not row:
                logger.error(f"No log entry found for ID {logId}")
                return

            actual_files = json.loads(row[0]) if row[0] else []

            if all_outputFiles:
                for file in all_outputFiles:
                    if file not in actual_files:
                        actual_files.append(file)
            elif outputFile and outputFile not in actual_files:
                actual_files.append(outputFile)

            actual_files_json = json.dumps(actual_files)
            c.execute(
                """UPDATE coauthor_logs SET
                outputFile = ?,
                actualOutputFiles = ?
                WHERE id = ?""",
                (outputFile, actual_files_json, logId),
            )

            conn.commit()
    except sqlite3.Error as e:
        logger.error(f"Failed to update output files: {e}")
        raise


def getLogEntry(logId: int) -> dict[str, str | int | float | list[str] | dict]:
    """Retrieve complete log entry information for a specific ID."""

    # the idea is that we can retrive the state of panel by using JSON.parse

    try:
        with sqlite3.connect(getDbPath()) as conn:
            c = conn.cursor()
            c.execute("SELECT * FROM coauthor_logs WHERE id = ?", (logId,))
            row = c.fetchone()
            if not row:
                raise ValueError(f"No log entry found for ID {logId}")

            columns = [
                "id",
                "timestamp",
                "agent",
                "model",
                "temperature",
                "inputFile",
                "inputFiles",
                "auxiliaryFile",
                "auxiliaryFiles",
                "figureFile",
                "figureFiles",
                "referenceFile",
                "referenceFiles",
                "editedFile",
                "outputFiles",
                "outputNameOverride",
                "actualOutputFiles",
                "outputFile",
                "instruction",
                "toolFlags",
                "stateGlobal",
                "stateRounds",
            ]

            entry = {columns[i]: row[i] for i in range(len(columns))}

            json_fields = [
                "inputFiles",
                "auxiliaryFiles",
                "figureFiles",
                "referenceFiles",
                "outputFiles",
                "actualOutputFiles",
                "toolFlags",
                "stateGlobal",
                "stateRounds",
            ]

            for field in json_fields:
                if entry[field]:
                    entry[field] = json.loads(entry[field])

            return entry
    except sqlite3.Error as e:
        logger.error(f"Failed to retrieve log entry: {e}")
        raise
