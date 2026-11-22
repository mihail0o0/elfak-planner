import base64, json, os, pathlib, re
root = pathlib.Path(__file__).parent
src = root / 'src'
core = (src / 'core.js').read_text()
squircle = (src / 'squircle.js').read_text()
fonts = ''
for weight, name in ((500, 'Medium'), (600, 'Semibold')):
    b64 = base64.b64encode((src / 'fonts' / f'Chillax-{name}.woff2').read_bytes()).decode()
    fonts += f'@font-face {{ font-family: "Chillax"; src: url(data:font/woff2;base64,{b64}) format("woff2"); font-weight: {weight}; font-style: normal; font-display: swap; }}\n'
ICONS = json.loads((src / 'solar-icons.json').read_text())['icons']

def icon(m):
    name, size = m.group(1), m.group(2)
    if name not in ICONS:
        raise SystemExit(f'Nepoznata ikonica: {name}')
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="{size}" viewBox="0 0 24 24" aria-hidden="true">'
            + ICONS[name] + '</svg>')

app = (src / 'app.html').read_text().replace('/*CORE*/', core).replace('/*SQUIRCLE*/', squircle).replace('/*CHAT*/', (src / 'chat.js').read_text()).replace('/*FONTS*/', fonts)
app = re.sub(r'\{\{i:([a-z0-9-]+):(\d+)\}\}', icon, app)
app = app.replace('<title>Planer ispita</title>', '<title>Planer ispita</title>\n<!-- Ikonice: Solar icon set, 480 Design, CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/) -->', 1)
(root / 'dist').mkdir(exist_ok=True)
(root / 'dist/raspored-ispita.html').write_text(app)  # za Artifact (bez skeleta)
i = app.index('</style>') + len('</style>')
std = ('<!doctype html>\n<html lang="sr-Latn">\n<head>\n<meta charset="utf-8">\n'
       '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n'
       + app[:i] + '\n</head>\n<body>\n' + app[i:] + '\n</body>\n</html>\n')
(root / 'dist/index.html').write_text(std)

# Samostalna verzija (GitHub Pages + Supabase): prijava, baza, poruke uživo, fajlovi.
# Ključevi dolaze iz promenljivih okruženja (u GitHub Actions: Settings → Variables).
cfg = {'supabaseUrl': os.environ.get('SUPABASE_URL', ''), 'supabaseKey': os.environ.get('SUPABASE_ANON_KEY', '')}
hosted_head = ('<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js"></script>\n'
               f'<script>window.PLANER_CONFIG = {json.dumps(cfg)};</script>\n'
               '<script>\n' + (src / 'backend.js').read_text() + '\n</script>\n')
marker = '<script>\n' + core
assert marker in std
hosted = std.replace(marker, hosted_head + marker, 1)
site = root / 'site'; site.mkdir(exist_ok=True)
(site / 'index.html').write_text(hosted)
(root / 'index.html').write_text(hosted)
print('ok', len(app))
