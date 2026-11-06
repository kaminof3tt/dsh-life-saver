# -*- coding: utf-8 -*-
"""把 PDF 逐页转 PNG，便于 read_image 目视检查排版。

用法： python pdf2png.py <pdf> <输出前缀> [dpi]
产出：<前缀>1.png, <前缀>2.png ...
依赖：pymupdf（未装则 pip install pymupdf）
"""
import sys, pymupdf

pdf = sys.argv[1]
prefix = sys.argv[2] if len(sys.argv) > 2 else 'pg'
dpi = int(sys.argv[3]) if len(sys.argv) > 3 else 110

doc = pymupdf.open(pdf)
print('pages', doc.page_count)
for i, p in enumerate(doc):
    pix = p.get_pixmap(dpi=dpi)
    fn = f'{prefix}{i + 1}.png'
    pix.save(fn)
    print(fn, pix.width, pix.height)
