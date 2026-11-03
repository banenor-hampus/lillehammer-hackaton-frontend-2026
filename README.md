# Buss for tog – frontend

En responsiv React- og TypeScript-klient for BussForTog API-et. Den henter stasjoner, avganger og rutedetaljer direkte fra backend.

## Kom i gang

Forutsetter Node.js og npm. Start backend først på `http://localhost:5087`, og kjør deretter fra `frontend`-mappen:

```powershell
npm install
npm run dev
```

Åpne adressen Vite viser i terminalen, normalt `http://localhost:5173`.

API-adressen kan endres med en lokal `.env`-fil:

```dotenv
VITE_API_BASE_URL=http://localhost:5087
```

Backend må tillate frontendens origin i `Cors:AllowedOrigins`. Standardoppsettet tillater `http://localhost:5173`.

## Funksjonalitet

- Henter tilgjengelige stasjoner fra `GET /api/stasjoner`.
- Validerer dato, tidsvindu i formatet `HH:MM` (`00:00`–`48:00`) og avganger per side (1–20, standard 20) før søk. Tidsvinduet konverteres til sekunder når API-et kalles.
- Viser «Fra» (første stopp) og «Til» (destinasjon) på hver avgang. Detaljvinduet lukkes med ×-knappen, Esc eller ved å klikke «Detaljer» igjen.
- Blar mellom sider med «Forrige» / «Neste» når det finnes flere avganger enn sidestørrelsen. API-et har ingen offset, så frontenden henter et økende antall avganger (maks 100 per kall) og viser riktig utsnitt; rutedetaljer hentes kun for gjeldende side og caches. Treffer søket API-grensen på 100, vises et notat om at det kan finnes flere.
- Henter avganger fra `GET /api/avganger`, fjerner duplikater på avgangs-ID og henter rutedetaljer med begrenset parallellitet.
- Viser planlagte, forventede og faktiske tider, stopp, transporttype og tog som eventuelt erstattes.
- Viser forståelige feil for valideringsfeil, utilgjengelig backend, HTTP-feil og delvise GraphQL-svar.
