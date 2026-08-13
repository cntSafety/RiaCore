from PIL import Image, ImageDraw
import os

src = os.path.join(os.path.dirname(__file__), 'Ria_Logo.png')
out = os.path.join(os.path.dirname(__file__), 'icon_1024.png')

img = Image.open(src).convert('RGBA')
w, h = img.size  # 5632 x 3072

# Center-crop to square (circle fills the height), zoom in to 85% to enlarge content
side = int(h * 0.85)
left = (w - side) // 2
top = (h - side) // 2
img = img.crop((left, top, left + side, top + side))

# Apply circular mask with inset for clean edges
inset = int(side * 0.03)
mask = Image.new('L', (side, side), 0)
draw = ImageDraw.Draw(mask)
draw.ellipse((inset, inset, side - inset - 1, side - inset - 1), fill=255)

result = Image.new('RGBA', (side, side), (0, 0, 0, 0))
result.paste(img, mask=mask)

# Resize to 1024x1024
result = result.resize((1024, 1024), Image.LANCZOS)
result.save(out, 'PNG')
print(f'Saved {out}')
