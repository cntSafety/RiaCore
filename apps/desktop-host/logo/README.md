# Icon Generation

## Prerequisites

Python 3 with Pillow:

```bash
pip install Pillow
```

## Usage

Place your final 1024x1024 icon as `icon_1024.png` in this folder, then run:

```bash
python generate_icons.py
```

Output (relative to `apps/desktop-host/`):

```
build/icons/png/    → 16, 24, 32, 48, 64, 128, 256, 512, 1024 px
build/icons/win/    → icon.ico
build/icons/mac/    → icon.icns (macOS only, requires iconutil)
```
