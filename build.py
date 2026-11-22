import base64, pathlib
root = pathlib.Path(__file__).parent
src = root / 'src'
core = (src / 'core.js').read_text()
squircle = (src / 'squircle.js').read_text()
fonts = ''
for weight, name in ((500, 'Medium'), (600, 'Semibold')):
    b64 = base64.b64encode((src / 'fonts' / f'Chillax-{name}.woff2').read_bytes()).decode()
    fonts += f'@font-face {{ font-family: "Chillax"; src: url(data:font/woff2;base64,{b64}) format("woff2"); font-weight: {weight}; font-style: normal; font-display: swap; }}\n'
app = (src / 'app.html').read_text().replace('/*CORE*/', core).replace('/*SQUIRCLE*/', squircle).replace('/*FONTS*/', fonts)
(root / 'dist').mkdir(exist_ok=True)
(root / 'dist/raspored-ispita.html').write_text(app)  # za Artifact (bez skeleta)
i = app.index('</style>') + len('</style>')
std = ('<!doctype html>\n<html lang="sr-Latn">\n<head>\n<meta charset="utf-8">\n'
       '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n'
       + app[:i] + '\n</head>\n<body>\n' + app[i:] + '\n</body>\n</html>\n')
(root / 'dist/index.html').write_text(std)
(root / 'index.html').write_text(std)
print('ok', len(app))
