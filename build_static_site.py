from __future__ import annotations

import shutil
from pathlib import Path


ROOT = Path(__file__).resolve().parent
OUTPUT = ROOT / "site-dist"


def main() -> None:
    if OUTPUT.exists():
        shutil.rmtree(OUTPUT)
    (OUTPUT / "data").mkdir(parents=True)

    for name in ("index.html", "styles.css", "app.js"):
        shutil.copy2(ROOT / name, OUTPUT / name)
    for name in ("records.json", "recent.json", "manifest.json", "profiles.json", "status.json"):
        shutil.copy2(ROOT / "data" / name, OUTPUT / "data" / name)
    shutil.copytree(ROOT / "data" / "years", OUTPUT / "data" / "years")

    (OUTPUT / ".nojekyll").write_text("", encoding="ascii")
    print(f"built static site at {OUTPUT}")


if __name__ == "__main__":
    main()
