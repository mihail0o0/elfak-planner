# Raspored ispita (elfak-planner)

Web aplikacija koja iz PDF rasporeda ispita (ćirilica) izvlači ispite, prebacuje ih na latinicu
i prikazuje u kalendaru (mesečni, godišnji i tabelarni prikaz) sa filterima po roku, nivou,
semestru, modulu, akreditaciji, datumu i nazivu predmeta.

- `index.html` – samostalna aplikacija; otvori je u pregledaču. Podaci se čuvaju u localStorage.
- `src/core.js` – transliteracija i parser PDF redova (koristi pdf.js 3.11.174 sa cdnjs).
- `src/app.html` – interfejs; `python3 build.py` spaja `core.js` u `dist/`.

Jedan PDF = jedan ispitni rok. Rok i školska godina se pogađaju iz naziva fajla i datuma, i mogu se promeniti pre čuvanja.

Format podataka po roku: metapodaci `{id, rok, godina, fileName, uploadedAt, count, od, do}` i redovi
`[nivo, akreditacija, semestar, modul, šifra, predmet, "YYYY-MM-DD", "HH:MM"]`.
