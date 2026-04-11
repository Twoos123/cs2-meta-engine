"""
Extract CS2 callout polygons into backend/data/callouts/*.json.

CS2 (unlike CS:GO) moved callouts out of the .nav file and into per-map VPK
entities (`env_cs_place`), so awpy alone can't hand us "BApartments" from a
world coordinate anymore. `mwridgway/CS2Callouts` parses those entities out
of a local CS2 install and emits per-map JSON with callout names + 2D
convex-hull polygons in world units.

This script:

1. Clones CS2Callouts into `.cache/CS2Callouts/` (next to the project root)
   if it isn't already there.
2. Patches upstream's broken `pyproject.toml` (the repo ships it with a
   malformed `[build-system]` header that pip can't parse).
3. `pip install -e` it into the active interpreter so its `cs2_callouts`
   module and dependencies (numpy, trimesh, click, matplotlib, requests)
   are available.
4. Runs `python -m cs2_callouts pipeline --map de_X` for each competitive
   map. This is the full "extract entities + process to 2D polygons" flow;
   its output lands at `<clone>/out/{map}_callouts.json` which we then copy
   into `backend/data/callouts/`.

Prerequisite: a working CS2 install discoverable through Steam. The
upstream tool auto-detects the VPK path, so no manual config is needed on
a typical Windows install. Pass `--vpk-path "C:\\path\\to\\pak01_dir.vpk"`
to this script to override.

Run once after installing CS2 — the generated JSON is static and should
be committed to the repo alongside the rest of the data files.
"""
from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path

REPO_URL = "https://github.com/mwridgway/CS2Callouts.git"

COMPETITIVE_MAPS = [
    "de_mirage",
    "de_dust2",
    "de_inferno",
    "de_nuke",
    "de_ancient",
    "de_anubis",
    "de_vertigo",
    "de_overpass",
    "de_train",
]

# Upstream's pyproject.toml ships with a malformed TOML table header:
#   [
#     "build-system"
#   ]
# which pip rejects. We rewrite it with a valid header on every run so a
# stale clone still works.
FIXED_PYPROJECT = """\
[build-system]
requires = ["setuptools>=68", "wheel"]
build-backend = "setuptools.build_meta"

[project]
name = "cs2-callouts"
version = "0.1.0"
description = "Extract and transform CS2 callout polygons from decompiled assets"
readme = "README.md"
requires-python = ">=3.10"
authors = [
  { name = "CS2Callouts" }
]
dependencies = [
  "numpy",
  "trimesh",
  "click",
  "matplotlib",
  "requests"
]

[project.scripts]
cs2-callouts = "cs2_callouts.cli:cli"
cs2-callouts-viz = "cs2_callouts.visualize:main"
cs2-callouts-clean = "cs2_callouts.cli:clean"
cs2-callouts-setup = "cs2_callouts.cli:setup"

[tool.setuptools]
packages = ["cs2_callouts"]
"""


def _project_root() -> Path:
    return Path(__file__).resolve().parent.parent


def _utf8_env() -> dict[str, str]:
    """Force UTF-8 I/O so upstream's click.echo emoji output doesn't crash cp1252."""
    env = os.environ.copy()
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONUTF8"] = "1"
    return env


def _ensure_clone(cache_dir: Path) -> Path:
    """Clone CS2Callouts into `cache_dir` if missing, return the path."""
    target = cache_dir / "CS2Callouts"
    if target.exists():
        print(f"[extract_callouts] using existing clone at {target}")
    else:
        cache_dir.mkdir(parents=True, exist_ok=True)
        print(f"[extract_callouts] cloning {REPO_URL} -> {target}")
        subprocess.run(
            ["git", "clone", "--depth", "1", REPO_URL, str(target)],
            check=True,
        )

    _patch_pyproject(target)
    return target


def _patch_pyproject(pkg_dir: Path) -> None:
    """Rewrite upstream's broken pyproject.toml with a valid header."""
    pp = pkg_dir / "pyproject.toml"
    current = pp.read_text(encoding="utf-8") if pp.exists() else ""
    if current.strip().startswith("[build-system]"):
        return
    print(f"[extract_callouts] patching malformed pyproject.toml at {pp}")
    pp.write_text(FIXED_PYPROJECT, encoding="utf-8")


def _pip_install_editable(pkg_dir: Path) -> None:
    print(f"[extract_callouts] pip install -e {pkg_dir}")
    subprocess.run(
        [sys.executable, "-m", "pip", "install", "-e", str(pkg_dir)],
        check=True,
        env=_utf8_env(),
    )


def _extract_map(
    map_name: str,
    out_dir: Path,
    work_dir: Path,
    vpk_path: str | None,
) -> bool:
    """Run the upstream full pipeline for one map, return True on success."""
    cmd = [sys.executable, "-m", "cs2_callouts", "pipeline", "--map", map_name]
    if vpk_path:
        cmd.extend(["--vpk-path", vpk_path])

    print(f"[extract_callouts] running pipeline for {map_name} ...")
    result = subprocess.run(cmd, cwd=work_dir, env=_utf8_env())
    if result.returncode != 0:
        print(f"[extract_callouts]   {map_name} - pipeline failed", file=sys.stderr)
        return False

    # Upstream writes the processed polygon JSON to <work_dir>/out/{map}_callouts.json
    source = work_dir / "out" / f"{map_name}_callouts.json"
    if not source.exists():
        print(
            f"[extract_callouts]   {map_name} - expected {source} not produced",
            file=sys.stderr,
        )
        return False

    dest = out_dir / f"{map_name}.json"
    shutil.copyfile(source, dest)
    print(f"[extract_callouts]   -> {dest}")
    return True


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--maps",
        nargs="+",
        default=COMPETITIVE_MAPS,
        help="Map tokens to extract (default: all competitive maps)",
    )
    ap.add_argument(
        "--vpk-path",
        default=None,
        help="Override auto-detected path to pak01_dir.vpk",
    )
    ap.add_argument(
        "--skip-install",
        action="store_true",
        help="Skip the pip install step (useful if CS2Callouts is already installed)",
    )
    args = ap.parse_args()

    root = _project_root()
    cache_dir = root / ".cache"
    out_dir = root / "backend" / "data" / "callouts"
    out_dir.mkdir(parents=True, exist_ok=True)

    pkg_dir = _ensure_clone(cache_dir)
    if not args.skip_install:
        _pip_install_editable(pkg_dir)

    failures: list[str] = []
    for m in args.maps:
        ok = _extract_map(m, out_dir=out_dir, work_dir=pkg_dir, vpk_path=args.vpk_path)
        if not ok:
            failures.append(m)

    if failures:
        print(
            f"\n[extract_callouts] done with {len(failures)} failures: {failures}",
            file=sys.stderr,
        )
        return 1

    print(f"\n[extract_callouts] done - {len(args.maps)} maps written to {out_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
