"""Build the Chrome Web Store upload package from dist/.

PowerShell 5.1's Compress-Archive writes backslash path separators, which the
Chrome Web Store cannot read. This writes forward slashes, as the ZIP spec
requires, and asserts that manifest.json ends up at the archive root.

Usage:
    npm run build
    python scripts/mkzip.py [version]
"""

import json
import pathlib
import sys
import zipfile

REPO = pathlib.Path(__file__).resolve().parent.parent
DIST = REPO / "dist"
RELEASE = REPO / "release"


def main() -> int:
    if not (DIST / "manifest.json").exists():
        print("dist/manifest.json not found — run `npm run build` first.")
        return 1

    version = sys.argv[1] if len(sys.argv) > 1 else json.loads(
        (DIST / "manifest.json").read_text(encoding="utf-8")
    )["version"]

    RELEASE.mkdir(exist_ok=True)
    out = RELEASE / f"HTMLHub_v{version}.zip"
    if out.exists():
        out.unlink()

    count = 0
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for path in sorted(DIST.rglob("*")):
            if path.is_file():
                z.write(path, path.relative_to(DIST).as_posix())
                count += 1

    with zipfile.ZipFile(out) as z:
        names = z.namelist()
        assert "manifest.json" in names, "manifest.json is not at the archive root"
        assert not any("\\" in n for n in names), "backslash separator found"

    print(f"{out}  ({count} entries, {out.stat().st_size / 1024:.1f} KB)")
    print("manifest.json at root: OK / separators: all '/'")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
