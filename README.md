# Planer ispita (elfak-planner)

Web aplikacija za planiranje ispita. Iz PDF rasporeda ispita (ćirilica) izvlači ispite, prebacuje ih
na latinicu i prikazuje u kalendaru (plan, mesečni, godišnji i tabelarni prikaz).

## Planiranje

- **Profil** (čarobnjak pri prvom otvaranju, kasnije „Podešavanja"): nivo (OAS/MAS), akreditacija,
  godina i modul. Prikazuju se samo predmeti iz tekuće i prethodnih godina, modula i zajednički (SVI).
  Koraci se sami preskaču kad postoji samo jedna mogućnost (npr. master ima jednu godinu, prva godina nema modul).
- **Preostali ispiti**: unapred su označeni obavezni (`…O01`) i završni predmeti tekuće godine;
  izborni (`…A01`, `…B01`…) i ispiti iz ranijih godina se dodaju ručno.
- **Zakazivanje**: klik na ispit u „Moji ispiti" → kalendar označava dane kada taj predmet ima ispit → klik na dan.
- **Konflikti**: manji = isti dan, drugo vreme (narandžasto); veći = isti dan i isto vreme (crveno,
  uz upozorenje pre zakazivanja, sa opcijom „Zakaži svejedno").
- Profil i plan su lični (`data/users/<id>/profile` u bazi artifakta, ili localStorage van njega);
  rokovi su zajednički.

## Profil i prijatelji

- Prvo pokretanje: koraci Profil (ime, prezime, broj indeksa, fakultet, opciona slika – inače avatar
  sa inicijalima) → studije → ispiti. Kasnije se sve menja u Podešavanjima (tabovi Profil, Studije,
  Ispiti, Privatnost).
- Svaki korisnik objavljuje javnu karticu `people/<uid>` (ime, indeks, fakultet, slika, studije i –
  ako je deljenje uključeno – plan). Pravila baze: karticu menja samo vlasnik, čitaju je korisnici sa
  pristupom „interact" i više.
- Prijateljstvo: svako u svoju karticu upisuje koga je dodao; kad su oboje dodali jedno drugo, to su
  prijatelji. Zahtevi = ljudi koji su tebe dodali, a ti njih nisi.
- Zajedničko planiranje: avatari prijatelja u kalendaru i listi ispita, „Prijatelji ovog dana",
  plan prijatelja sa „Pridruži se" (isti termin) i podatak u dijalogu potvrde ko polaže u istom terminu.

- `index.html` – samostalna aplikacija; otvori je u pregledaču. Podaci se čuvaju u localStorage.
- `src/core.js` – transliteracija i parser PDF redova (koristi pdf.js 3.11.174 sa cdnjs).
- `src/app.html` – interfejs; `python3 build.py` spaja `core.js` u `dist/`.

Jedan PDF = jedan ispitni rok. Rok i školska godina se pogađaju iz naziva fajla i datuma, i mogu se promeniti pre čuvanja.

Format podataka po roku: metapodaci `{id, rok, godina, fileName, uploadedAt, count, od, do}` i redovi
`[nivo, akreditacija, semestar, modul, šifra, predmet, "YYYY-MM-DD", "HH:MM"]`.

## Dizajn

Stil prati flow.remenex.com: Chillax (naslovi, dugmad; ugrađen kao woff2 u `src/fonts/`), Instrument Sans (tekst),
plava `#1a3ffb`, narandžasta `#f77d44`, svetla (`#f7f7f7`) i tamna (neutralne pozadine `#0a0b10` / `#13151c` / `#1c1f28`) tema.
Squircle uglovi: nativno preko `corner-shape: squircle` gde pregledač to podržava, inače `src/squircle.js`
crta isti oblik kao SVG pozadinu (sa ivicom i senkom).

## Ikonice

[Solar icon set](https://www.figma.com/community/file/1166831539721848736) autora 480 Design, licenca
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Korišćene ikonice su u `src/solar-icons.json`
(iz paketa `@iconify-json/solar`); u kodu se pišu kao `{{i:ime:veličina}}`, a `build.py` ih ugrađuje kao SVG.
