#!/usr/bin/env python3
"""Writes the clock's typefaces into app/clock/: only the characters a clock needs.

    python3 docs/art/clock-fonts.py <folder with the source fonts>

Needs fontTools and brotli. The sources, all under the SIL Open Font License 1.1, whose texts
are copied beside the fonts as app/clock/OFL-<name>.txt:

    cormorant.ttf      CormorantGaramond[wght].ttf, github.com/google/fonts ofl/cormorantgaramond
    jetbrainsmono.ttf  JetBrainsMono[wght].ttf, github.com/google/fonts ofl/jetbrainsmono
    nunito.ttf         Nunito[wght].ttf, github.com/google/fonts ofl/nunito
    DSEG7Classic-Light.ttf  fonts-DSEG_v046.zip, github.com/keshikan/DSEG releases v0.46

DSEG has the Reserved Font Name "DSEG": a subset is a modified version, so it is renamed.
"""
import os, sys
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer
from fontTools import subset

TEXT = '0123456789:AMP '
SRC = sys.argv[1]
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'app', 'clock')
FONTS = [  # name in Lightkeeper, source file, weight to fix a variable font at, new family name or None
    ('classic', 'cormorant.ttf', 300, None),
    ('mono', 'jetbrainsmono.ttf', 200, None),
    ('rounded', 'nunito.ttf', 300, None),
    ('digital', 'DSEG7Classic-Light.ttf', None, 'Lightkeeper Segments'),
]
os.makedirs(OUT, exist_ok=True)
for name, src, weight, rename in FONTS:
    font = TTFont(os.path.join(SRC, src))
    if weight is not None and 'fvar' in font:
        font = instancer.instantiateVariableFont(font, {'wght': weight})
    opts = subset.Options()
    opts.flavor = 'woff2'
    opts.hinting = False
    opts.name_IDs = ['*']
    opts.layout_features = opts.layout_features + ['lnum']  # Cormorant's lining figures, which the page turns on
    sub = subset.Subsetter(opts)
    sub.populate(text=TEXT)
    sub.subset(font)
    if rename:
        for rec in font['name'].names:
            if rec.nameID in (1, 3, 4, 6, 16, 17, 21, 22):
                rec.string = rename.replace(' ', '') if rec.nameID == 6 else rename
    path = os.path.join(OUT, name + '.woff2')
    font.flavor = 'woff2'
    font.save(path)
    print('%-8s %5d bytes  %s' % (name, os.path.getsize(path), ''.join(sorted(set(TEXT) & set(chr(c) for c in font.getBestCmap())))))
