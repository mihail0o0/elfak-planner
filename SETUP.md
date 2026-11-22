# Postavljanje aplikacije (GitHub Pages + Supabase)

Aplikacija je statička stranica (GitHub Pages). Prijava, baza, poruke uživo i fajlovi idu preko
[Supabase](https://supabase.com) (besplatan plan: 50.000 korisnika mesečno, 500 MB baze, 1 GB fajlova).

## 1. Supabase projekat
1. Napravi nalog na supabase.com → **New project** (region: Frankfurt / Central EU).
2. **SQL Editor** → nalepi ceo sadržaj `supabase/schema.sql` → **Run**.
   Ovo pravi tabelu, pravila pristupa (RLS), izmene uživo i bucket `attachments` za fajlove.
3. **Project Settings → API**: zapiši **Project URL** i **anon public** ključ (javan je, zaštitu daju pravila u bazi).

## 2. Prijava
U **Authentication**:
- **URL Configuration**: *Site URL* i *Redirect URLs* = `https://mihail0o0.github.io/elfak-planner/`
- **Providers → Email**: uključi, *Confirm email* = ON (korisnik mora da potvrdi email).
- **Providers → Google**: u [Google Cloud Console](https://console.cloud.google.com/) napravi *OAuth client ID* (Web application),
  *Authorized redirect URI* = `https://<tvoj-projekat>.supabase.co/auth/v1/callback`; Client ID i Secret nalepi u Supabase.
- **Providers → Facebook**: na [developers.facebook.com](https://developers.facebook.com/) napravi aplikaciju sa *Facebook Login*,
  *Valid OAuth Redirect URI* = isti callback; App ID i App Secret nalepi u Supabase.
- **Sign In / Providers → Allow manual linking** = ON (povezivanje Google/Facebook naloga u Podešavanjima → Nalog).
- **SMTP Settings**: ugrađeni Supabase email šalje samo nekoliko poruka na sat. Za prave korisnike podesi
  sopstveni SMTP (npr. Resend ili Brevo, besplatni planovi) da bi mejlovi za potvrdu stizali.

## 3. GitHub
1. Repo → **Settings → Secrets and variables → Actions → Variables**: dodaj
   `SUPABASE_URL` i `SUPABASE_ANON_KEY` (vrednosti iz koraka 1.3).
2. Repo → **Settings → Pages → Source: GitHub Actions**.
3. Spoji granu u `main` → workflow „Objavi na GitHub Pages" gradi `site/` i objavljuje stranicu.

## 4. Prvi koraci u aplikaciji
- Prijavi se, potvrdi email i dodaj prvi ispitni rok (PDF) u sekciji **Rokovi**.
- Gosti mogu da koriste planer bez naloga (plan ostaje na uređaju). Kad naprave nalog, plan se prenosi.

## Lokalno
`SUPABASE_URL=... SUPABASE_ANON_KEY=... python3 build.py` → otvori `site/index.html` preko lokalnog servera
(npr. `python3 -m http.server -d site`). Bez promenljivih stranica radi kao gost (samo lokalno čuvanje).

## Šta gde živi
- `src/app.html`, `src/core.js`, `src/chat.js` – aplikacija (ista i za claude.ai verziju).
- `src/backend.js` – prijava i povezivanje sa Supabase-om (baza, online status, fajlovi).
- `dist/raspored-ispita.html` – verzija za claude.ai Artifact; `site/index.html` – verzija za GitHub Pages.
