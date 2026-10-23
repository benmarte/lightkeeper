#!/usr/bin/env python3
"""Turns the brand logos listed in logos-commons.tsv into the white pictures in app/logos/.

Put each SVG, downloaded from Wikimedia Commons, as <name>.svg beside this script, then run it with
Python 3 and Pillow. Each logo is drawn by Chrome, then made white: what is white in the original,
drawn over a colour, becomes a hole, as in the brands' own one-colour versions.
"""
import os, subprocess, tempfile, sys
from PIL import Image
C = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
here = os.path.dirname(os.path.abspath(__file__))
tmp = tempfile.mkdtemp()
for f in sorted(os.listdir(here)):
    if not f.endswith('.svg'): continue
    n = f[:-4]
    html = os.path.join(tmp, n + '.html')
    open(html, 'w').write('<html><body style="margin:20px;background:transparent"><img src="file://%s/%s" style="height:240px"></body></html>' % (here, f))
    raw = os.path.join(tmp, n + '.raw.png')
    subprocess.run([C, '--headless=new', '--disable-gpu', '--hide-scrollbars', '--default-background-color=00000000',
                    '--window-size=2400,300', '--allow-file-access-from-files', '--user-data-dir=' + tempfile.mkdtemp(),
                    '--screenshot=' + raw, 'file://' + html], stderr=subprocess.DEVNULL)
    im = Image.open(raw).convert('RGBA')
    px = im.load()
    out = Image.new('RGBA', im.size, (255, 255, 255, 0))
    po = out.load()
    for y in range(im.size[1]):
        for x in range(im.size[0]):
            r, g, b, a = px[x, y]
            if not a: continue
            # White drawn over a colour is a hole, as in the brands' own one-colour versions.
            w = min(max((min(r, g, b) - 200) / 40.0, 0.0), 1.0)
            po[x, y] = (255, 255, 255, int(round(a * (1 - w))))
    box = out.getbbox()
    out = out.crop(box)
    out.save(os.path.join(here, '..', '..', 'app', 'logos', n + '.png'), optimize=True)
    print(n, out.size)
