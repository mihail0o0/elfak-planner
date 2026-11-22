import pathlib
root = pathlib.Path(__file__).parent
core = (root/'src/core.js').read_text()
app = (root/'src/app.html').read_text().replace('/*CORE*/', core)
(root/'dist').mkdir(exist_ok=True)
(root/'dist/raspored-ispita.html').write_text(app)  # za Artifact (bez skeleta)
head = '<!doctype html>\n<html lang="sr-Latn">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n'
title_end = app.index('<style>')
std = head + app[:title_end] + app[title_end:app.index('</style>')+8] + '\n</head>\n<body>\n' + app[app.index('</style>')+8:] + '\n</body>\n</html>\n'
(root/'dist/index.html').write_text(std)
print('ok', len(app))
