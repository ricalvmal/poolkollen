# Didriksons Poolkollen – demo

En klickbar demo av poolövervakning och bokning av servicebesök. All data är påhittad.

**För företaget (teknikern)**
- **Översikt:** alla 42 pooler med status, grafer och föreslagen åtgärd.
- **Larm:** aktiva larm och historik. Teknikern kvitterar med en kommentar.
- **Servicebesök:** veckokalender, nya kundbokningar och säsongsmätare. Besök som saknar rapport markeras.
- **Kunder och pooler:** kundkort med avtal, poolfakta, bokningar, rapporter och larmhistorik.
- **Servicerapport:** mätvärden före och efter, tillsatt kemi och anteckningar. Kan stänga larmen, så att poolen blir grön igen.
- **Statistik:** larm per vecka, tid till kvittering, pooler med flest larm och kemikalieförbrukning.

**För kunden (appen)**
- **Hem:** poolens status, värden och veckograf.
- **Historik:** grafer för 7 eller 30 dagar och alla servicerapporter.
- **Boka:** service, vinterstängning och vårstart i lediga tider.
- **Meddelanden:** larm, påminnelser, bekräftelser och nya rapporter, med notis för olästa.

Allt hänger ihop. Bokar kunden syns det hos teknikern, och bekräftar teknikern får kunden ett meddelande. Skriver teknikern en rapport dyker den upp i kundens app.

Allt körs med bara två tjänster:

- **GitHub** lagrar filerna och visar webbsidan (GitHub Pages).
- **Supabase** är databasen och sköter inloggningen.

Det finns inget byggsteg och inget att installera.

## Demokonton

Alla har lösenordet `demo1234`. På inloggningssidan finns knappar för snabbinloggning.

| Konto | Roll |
|---|---|
| tekniker@poolkollen.demo | Personal, ser allt |
| anna@poolkollen.demo | Kund, pool som mår bra |
| berg@poolkollen.demo | Kund, pool med larm |

---

## Så sätter du upp demon (ca 20 minuter)

### Steg 1 – Supabase: skapa databasen

1. Logga in på [supabase.com](https://supabase.com/dashboard) och välj **New project**.
2. Ge projektet namnet `poolkollen`, hitta på ett databaslösenord (spara det) och välj region **North EU (Stockholm)** om den finns. Klicka **Create new project** och vänta någon minut.
3. Öppna **SQL Editor** i menyn till vänster och välj **New query**.
4. Öppna filen `supabase/setup.sql`, kopiera **hela** innehållet och klistra in det.
5. Klicka **Run**. Om Supabase varnar för att frågan är "destructive" (den bygger om demotabellerna) väljer du att köra ändå.
6. Längst ner ska du se `42` pooler och `3` demokonton. Då är databasen klar.

### Steg 2 – Supabase: hämta två värden

Klicka på **Connect** högst upp i projektet, eller gå till **Project Settings → API Keys** och **Data API**. Kopiera:

- **Project URL**, som ser ut som `https://abcdefgh.supabase.co`
- **Publishable key**, som börjar med `sb_publishable_`. Finns den inte, använd **anon public**-nyckeln.

Båda är tänkta att vara publika. **Service role key och secret key ska du aldrig använda eller dela.**

### Steg 3 – GitHub: lägg upp filerna

1. Gå till [github.com/new](https://github.com/new).
2. Döp repot till `poolkollen` och välj **Public**. Med ett gratiskonto kräver GitHub Pages att repot är publikt. Det gör inget här, eftersom allt är påhittad demodata och lösenorden till databasen inte finns i filerna.
3. Klicka **Create repository** och sedan länken **uploading an existing file**.
4. Packa upp zip-filen. Öppna mappen `poolkollen` och dra in **allt innehåll i den** (`index.html`, `app.js`, `config.js`, `styles.css`, `icon.svg` och mapparna `vendor` och `supabase`).
5. Klicka **Commit changes**.

### Steg 4 – Lägg in dina två värden

1. Klicka på filen **`config.js`** i repot och sedan på **pennan** (Edit) uppe till höger.
2. Byt ut `https://DITT-PROJEKT.supabase.co` mot din Project URL och `DIN-PUBLISHABLE-KEY` mot din nyckel. Behåll citattecknen.
3. Klicka **Commit changes**.

### Steg 5 – Slå på GitHub Pages

1. Gå till repots **Settings → Pages**.
2. Under **Build and deployment**, välj **Deploy from a branch**, sedan branch **main** och mapp **/ (root)**. Klicka **Save**.
3. Vänta en till två minuter och ladda om sidan. Överst visas adressen, till exempel `https://ditt-namn.github.io/poolkollen/`.

Klart! Adressen fungerar i både dator och mobil.

---

## Uppdatera en demo som redan är uppsatt

1. **Supabase:** kör hela den nya `supabase/setup.sql` i SQL Editor igen. Demodatan byggs om, och demokontona finns kvar.
2. **GitHub:** klicka **Add file → Upload files** i repot och dra in `app.js` och `styles.css`. De ersätter de gamla filerna. Rör inte `config.js`, där ligger dina nycklar.
3. Vänta en minut och ladda om sidan.

## Bra att veta

- **Återställ demon:** logga in som tekniker och tryck **Återställ demon** på översikten. Då får du nya mätvärden och bokningar som utgår från dagens datum. Gör det gärna innan du visar demon.
- **Ändringar syns inte direkt:** GitHub Pages behöver en minut eller två efter varje ändring. Ladda om sidan.
- **Pausat projekt:** gratisprojekt i Supabase pausas efter en tids inaktivitet. Logga då in på Supabase och tryck **Restore project**.
- **"Nästan klart":** visar sidan det har nycklarna i `config.js` inte fyllts i rätt.
- **Knappar som bara låtsas:** "Meddela kunden" och "Skicka påminnelse" skickar meddelanden som syns i kundens app. I en riktig version går de även ut som sms eller mejl.
- **Bra demo-ordning:** logga in som tekniker och visa Larm. Skriv sedan en servicerapport för Berg med rutan "Markera larmen som åtgärdade" ikryssad. Logga därefter in som Per Berg: poolen är grön och rapporten ligger under Meddelanden och Historik.

## Så är det byggt

| Fil | Innehåll |
|---|---|
| `index.html` | Sidan som laddas |
| `app.js` | All logik och alla vyer |
| `styles.css` | Utseendet |
| `config.js` | Dina två Supabase-värden |
| `vendor/supabase.js` | Supabase-biblioteket (version 2.117.2) |
| `supabase/setup.sql` | Databas, behörigheter, demodata och bokningsregler |

Behörigheterna ligger i databasen (Row Level Security). Även om någon läser koden på GitHub kan en kund bara se sin egen pool, och bara personal kan bekräfta bokningar eller återställa demon.
