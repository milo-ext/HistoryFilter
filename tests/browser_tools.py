"""Portable Firefox tool selection shared by the disposable-profile checks."""

import os
import shutil
from pathlib import Path


def add_firefox_arguments(parser):
    parser.add_argument("--geckodriver", default=os.environ.get("GECKODRIVER", "geckodriver"),
                        help="Driver executable path or command (default: GECKODRIVER, then PATH)")
    parser.add_argument("--firefox", default=os.environ.get("FIREFOX_BINARY", "firefox"),
                        help="Firefox executable path or command (default: FIREFOX_BINARY, then PATH)")


def firefox_tool_paths(args, parser):
    paths = []
    for name, variable in (("geckodriver", "GECKODRIVER"), ("firefox", "FIREFOX_BINARY")):
        executable = shutil.which(os.path.expanduser(getattr(args, name)))
        if not executable:
            parser.error(f"Cannot find {name}; set --{name}, {variable}, or add it to PATH.")
        paths.append(Path(executable).resolve())
    return tuple(paths)
