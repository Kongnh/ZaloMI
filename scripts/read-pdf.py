"""Text of a PDF for the zalo-mi skill, with images for scanned pages.

    python -E scripts/read-pdf.py <file.pdf> [--pages 1-3] [--out DIR]

Prints each page's text layer (PyMuPDF keeps Vietnamese diacritics, which pdftotext garbles on many government PDFs).
A page with almost no text is a scan: it is rendered to <DIR>/<name>-p<N>.png (default: the system temp folder) and the
path is printed instead, so Claude can open the image. Reads the PDF only; writes nothing next to it.

Run with -E (not -I): PyMuPDF lives in the user site-packages, which -I hides. Run it from outside the data folder.
"""
import argparse
import os
import sys
import tempfile

import fitz  # PyMuPDF

SCAN_MAX_CHARS = 40  # a page with fewer text characters than this is treated as a scan


def page_range(spec, count):
    if not spec:
        return range(count)
    first, _, last = spec.partition('-')
    first = max(1, int(first))
    last = min(count, int(last or first))
    return range(first - 1, last)


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('pdf')
    parser.add_argument('--pages', help='e.g. 1-3 (default: all)')
    parser.add_argument('--out', default=tempfile.gettempdir(), help='folder for rendered scan pages')
    args = parser.parse_args()
    sys.stdout.reconfigure(encoding='utf-8')

    doc = fitz.open(args.pdf)
    base = os.path.splitext(os.path.basename(args.pdf))[0][:60]
    print(f'# {os.path.basename(args.pdf)} ({doc.page_count} trang)')
    for i in page_range(args.pages, doc.page_count):
        text = doc[i].get_text().strip()
        print(f'\n--- trang {i + 1} ---')
        if len(text) >= SCAN_MAX_CHARS:
            print(text)
            continue
        os.makedirs(args.out, exist_ok=True)
        png = os.path.join(args.out, f'{base}-p{i + 1}.png')
        doc[i].get_pixmap(dpi=80).save(png)
        print(f'[trang scan, không có chữ] ảnh: {png}')


if __name__ == '__main__':
    main()
