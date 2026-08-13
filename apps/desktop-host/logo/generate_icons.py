"""
Generate all platform-specific icons for electron-builder from icon_1024.png.

Produces:
  build/icons/png/*.png   (16, 24, 32, 48, 64, 128, 256, 512, 1024)
  build/icons/win/icon.ico
  build/icons/mac/icon.icns (requires macOS; skipped on Windows)
"""

from PIL import Image
import struct
import os

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR = os.path.dirname(SCRIPT_DIR)
SRC_ICON = os.path.join(SCRIPT_DIR, 'icon_1024.png')

PNG_SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024]
ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]

def ensure_dir(path):
    os.makedirs(path, exist_ok=True)

def generate_pngs(img, out_dir):
    ensure_dir(out_dir)
    for size in PNG_SIZES:
        resized = img.resize((size, size), Image.LANCZOS)
        resized.save(os.path.join(out_dir, f'{size}x{size}.png'), 'PNG')
        print(f'  {size}x{size}.png')

def generate_ico(img, out_path):
    ensure_dir(os.path.dirname(out_path))
    # PIL can save .ico directly with multiple sizes
    sizes = [(s, s) for s in ICO_SIZES]
    img.save(out_path, format='ICO', sizes=sizes)
    print(f'  icon.ico ({len(ICO_SIZES)} sizes)')

def generate_icns(img, out_path):
    """Generate .icns on macOS using iconutil, skip on other platforms."""
    import platform
    if platform.system() != 'Darwin':
        print('  icon.icns skipped (not on macOS)')
        return

    import subprocess
    import tempfile
    import shutil

    iconset_dir = tempfile.mkdtemp(suffix='.iconset')
    try:
        icns_sizes = [16, 32, 64, 128, 256, 512, 1024]
        for size in icns_sizes:
            resized = img.resize((size, size), Image.LANCZOS)
            if size <= 512:
                resized.save(os.path.join(iconset_dir, f'icon_{size}x{size}.png'))
            if size >= 32:
                half = size // 2
                resized.save(os.path.join(iconset_dir, f'icon_{half}x{half}@2x.png'))

        ensure_dir(os.path.dirname(out_path))
        subprocess.run(['iconutil', '-c', 'icns', iconset_dir, '-o', out_path], check=True)
        print(f'  icon.icns')
    finally:
        shutil.rmtree(iconset_dir, ignore_errors=True)

def main():
    print(f'Source: {SRC_ICON}')
    img = Image.open(SRC_ICON).convert('RGBA')
    print(f'Size: {img.size[0]}x{img.size[1]}')
    print()

    icons_dir = os.path.join(PROJECT_DIR, 'build', 'icons')

    print('Generating PNGs...')
    generate_pngs(img, os.path.join(icons_dir, 'png'))

    print('Generating ICO...')
    generate_ico(img, os.path.join(icons_dir, 'win', 'icon.ico'))

    print('Generating ICNS...')
    generate_icns(img, os.path.join(icons_dir, 'mac', 'icon.icns'))

    print('\nDone!')

if __name__ == '__main__':
    main()
