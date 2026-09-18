# Pakbon Wit

Statische webapp (PWA) waarmee bouwplaatsmedewerkers pakbonnen fotograferen.
Geen backend, geen accounts, geen server, geen inloggen: alles gebeurt in de
browser van het toestel. De app opent meteen op het scanscherm; na het
fotograferen komt het bijsnijdscherm en daarna gaan de pagina's als bijlage naar
`pakbonnen@witwognum.nl`.

## Bestanden

| Bestand | Wat het doet |
|---|---|
| `index.html` | De drie schermen: aanmelden, scannen, afronden |
| `styles.css` | Vormgeving: grote knoppen, hoog contrast |
| `app.js` | Foto lezen, bewerken, bestandsnamen, opslaan |
| `config.js` | **Het enige bestand dat je aanpast** |
| `manifest.json`, `sw.js` | PWA: beginscherm-icoon en offline openen |
| `logo.png` | Het logo in de app |
| `icons/` | App-iconen, gemaakt van `logo.png` |

## Huisstijl

De kleuren komen rechtstreeks uit het logo: groen `#005837` en oranje `#F9A13A`.
Groen draagt de knoppen en de koppen — wit op dit groen leest ook in de zon
goed. Oranje is alleen accent: de streep onder de kopbalk en de rand van een
ingedrukte knop. Oranje met witte tekst heeft te weinig contrast voor buiten en
wordt daarom nergens als knopkleur gebruikt.

Vervang je het logo, verhoog dan `VERSIE` in `sw.js` en maak nieuwe iconen in
`icons/` (192×192, 512×512 en een maskable 512×512 met ruimere marge).

## Instellen

Open `config.js` en zet daar:

- `mailOntvanger` — het adres waar de pakbonnen naartoe gaan.
- `mailOnderwerp` — het onderwerp van de mail.
- `maxLangeZijde` / `minLangeZijde` — de maximale en minimale lange zijde in pixels.

Verder staat er niets hardcoded in de app.

## Lokaal proberen

De camera en de service worker werken niet vanaf een `file://`-pad. Start dus
een klein servertje in deze map en ga naar `http://localhost:8765`:

```bash
python -m http.server 8765
```

## Op GitHub Pages zetten

1. Maak een nieuwe repository op GitHub, bijvoorbeeld `pakbonnen`. Zet hem op
   **Public** — GitHub Pages werkt bij een gratis account alleen vanuit een
   openbare repository.
2. Zet alle bestanden uit deze map in de wortel van de repository, dus
   `index.html` direct in de repo en niet in een submap.

   **Zonder git (het snelst):** klik in de lege repository op *uploading an
   existing file*, sleep de losse bestanden erin (`index.html`, `styles.css`,
   `app.js`, `config.js`, `manifest.json`, `sw.js`, `logo.png`) plus de map
   `icons`, en klik op *Commit changes*. Sleep de map `pakbon-app` zelf er niet
   in: dan komt alles een niveau te diep te staan.

   **Met git:**

```bash
git init && git add . && git commit -m "Pakbon-app" && git branch -M main && git remote add origin https://github.com/<gebruiker>/pakbonnen.git && git push -u origin main
```

3. Ga in de repository naar **Settings → Pages**.
4. Bij **Source** kies je **Deploy from a branch**, branch `main`, map `/ (root)`.
   Opslaan.
5. Na een minuut staat de app op `https://<gebruiker>.github.io/pakbonnen/`.

GitHub Pages serveert over HTTPS, en dat is precies wat de camera en de service
worker nodig hebben. Alle paden in de app zijn relatief, dus het werkt ook in
een submap zoals hierboven.

### Op het beginscherm zetten

- **Android (Chrome):** open de link → menu (⋮) → *App installeren* of
  *Toevoegen aan startscherm*.
- **iPhone (Safari):** open de link → deelknop → *Zet op beginscherm*.

Daarna opent de app zonder adresbalk en werkt hij ook zonder bereik.

### Na een wijziging

De service worker cachet de app. Verhoog `VERSIE` bovenin `sw.js` als je
`index.html`, `app.js` of `styles.css` aanpast, anders blijven telefoons de oude
versie tonen. `config.js` wordt altijd eerst van het net gehaald, dus een nieuwe
OneDrive-link of pincode komt vanzelf door.

GitHub Pages zet tien minuten browsercache op elk bestand. Een telefoon die de
app al open had, kan dus even de oude versie blijven tonen; de service worker
haalt bij een nieuwe `VERSIE` verse kopieën op (`cache: 'reload'`) en is bij de
volgende start bij. Wil je zelf meteen de nieuwste versie zien, ververs dan hard
(Ctrl+F5) of wacht die tien minuten af.

## Hoe het werkt

### Foto maken

De app gebruikt `<input type="file" accept="image/*" capture="environment" multiple>`
en bewust **niet** `getUserMedia`. De native camera-app levert de volle resolutie
van het toestel (vaak 3000×4000 of meer); een videostream levert een fractie
daarvan. Bij elke miniatuur staat daarom de werkelijke resolutie van de camera
én die van het opgeslagen bestand, zodat je tijdens het testen ziet wat het
toestel echt levert. Staat de opgeslagen maat onder 1700×2400, dan waarschuwt
de app.

De foto wordt gelezen met `createImageBitmap(file, { imageOrientation: 'from-image' })`,
zodat de EXIF-orientatie wordt toegepast en liggende foto's rechtop staan.

### Rechttrekken en uitsnijden

Direct na het maken van de foto zoekt de app de rand van het papier: het beeld
gaat terug naar 320 px, licht wordt van donker gescheiden (Otsu), het grootste
aaneengesloten lichte vlak is het papier, en de vier uiterste punten daarvan
zijn de hoeken. Die vierhoek wordt met een projectieve transformatie naar een
rechthoek getrokken, bilineair bemonsterd.

Het uitsnijden gebeurt vóór het schalen, vanaf de volle resolutie van de camera,
zodat er geen detail verloren gaat. De hoeken gaan 1% naar buiten (`randMarge`),
want de detectie werkt op een grof raster en je wilt liever een dun randje tafel
meenemen dan een cijfer van de bon afsnijden. Dat randje is op het resultaat te
zien als een donker lijntje van ongeveer 13 px.

De detectie weigert zichzelf zodra iets niet klopt: het vlak is te klein of
beslaat bijna het hele beeld (papier en ondergrond even licht), de vorm is niet
vierhoekig of niet bol, een zijde is te kort, of de verhouding is extremer dan
1:5. Dan blijft de hele foto staan en meldt de app *"rand niet gevonden — hele
foto bewaard"*. Verkeerd uitsnijden is erger dan niet uitsnijden.

Direct na het fotograferen komt het bijsnijdscherm in beeld, met de gevonden
hoeken er al op als versleepbare punten; wat wegvalt is gedempt. De medewerker
tikt *Toepassen* en klaar, of sleept eerst een hoek die ernaast ligt.
*Foto weggooien* gooit de foto weg zonder er een pagina van te maken. Bij
meerdere foto's tegelijk komt het scherm één keer per foto langs.

Pas als de hoeken akkoord zijn, wordt er gesneden. De eerste ronde (lezen,
voorbeeld, rand zoeken) duurt ongeveer anderhalve seconde; het zware rekenwerk
komt daarna en gebeurt dus maar één keer.

Onder elke miniatuur staat **Bijsnijden** om het scherm opnieuw te openen, en
**Opnieuw** om een nieuwe foto voor die pagina te maken. Beide snijden uit vanaf
het originele camerabestand, dus bijstellen kost geen kwaliteit. Zet
`autoBijsnijden` in `config.js` op `false` om de detectie uit te schakelen; het
bijsnijdscherm blijft dan komen, met de hoeken op de rand van de foto.

### Beeldbewerking per pagina

0. **Uitsnijden en rechttrekken** (zie hierboven), vóór het schalen.
1. **Schalen** — alleen als de lange zijde groter is dan `maxLangeZijde` (2400),
   en nooit verder terug dan `minLangeZijde` (2000). Sterk verkleinen gebeurt
   stapsgewijs (halveren), anders worden letters kartelig.
2. **Witbalans** — van alle pixels met een luminantie tussen 150 en 252 (dat is
   het papier, en na het uitsnijden is dat vrijwel het hele beeld) wordt de
   gemiddelde R/G/B bepaald. De drie kanalen worden zo
   geschaald dat die kleur neutraal grijs wordt, met een rem van maximaal 25%
   per kanaal. Dit haalt de blauwzweem eruit.
3. **Contrast** — van diezelfde papierpixels wordt het 60e percentiel het
   witpunt, met een zwartpunt op 15. Per pagina apart berekend, zodat verschillen
   in lichtval tussen foto's verdwijnen zonder dat de inkt wegvalt.
4. **Exporteren** als JPEG, kwaliteit 0.9.

### Uitvoer

Eén bestand per pagina, niets wordt samengevoegd:

```
pakbon-2026-09-18-143052-p1.jpg
pakbon-2026-09-18-143052-p2.jpg
```

Datum en tijd komen van het moment waarop de eerste pagina van die pakbon werd
gemaakt, dus alle pagina's van één pakbon hebben dezelfde stempel. Wie de pakbon
instuurde blijkt uit het afzenderadres van de mail; daarom staat er geen naam
meer in de bestandsnaam.

### Verzenden

**Verzenden** geeft de foto's aan het deelmenu van de telefoon. Kiest de
medewerker daar zijn mailapp, dan opent die met de pagina's als bijlage en
`Pakbon` als onderwerp. Het adres staat eronder op het scherm, met een knop om
het te kopiëren.

Waarom het adres er niet vanzelf in staat: een deelmenu kent geen ontvanger, en
een `mailto:`-link — die wél een ontvanger en onderwerp kan invullen — mag geen
bijlagen meenemen. Geen enkele browser staat dat toe. Er is geen manier om
allebei tegelijk te krijgen, dus de bijlagen wegen zwaarder.

Tip voor in de praktijk: laat de medewerkers `pakbonnen@witwognum.nl` één keer
als contact op hun telefoon zetten. Dan is het in de mailapp twee letters typen
en tikken.

Kan het toestel geen bestanden delen (oudere browsers, een laptop), dan toont de
app in plaats daarvan **1. Opslaan op telefoon** en **2. Mail openen**. Die
tweede knop opent een lege mail met ontvanger en onderwerp al ingevuld en de
bestandsnamen in de tekst; de foto's moeten daar zelf bijgevoegd worden.

#### Van de mailbox naar een map

Wil je de pakbonnen uiteindelijk in een OneDrive- of SharePoint-map hebben, dan
doe je dat aan de ontvangende kant: een Power Automate-flow met *Wanneer een
nieuw e-mailbericht binnenkomt* → *Bestand maken*, met de bijlagen. Dat zijn
standaardconnectoren, dus daar is geen premium-licentie voor nodig. De app hoeft
er niet voor aangepast te worden.

## Beperkingen

- De pagina's staan alleen in het geheugen van de browser. Sluit de medewerker
  het tabblad voordat hij opslaat, dan zijn ze weg (de app waarschuwt daarvoor).
- iOS negeert `multiple` in combinatie met `capture`: daar maak je één foto per
  keer, wat met de knop "Pagina toevoegen" prima werkt.
- Meerdere downloads achter elkaar vragen op sommige toestellen eenmalig om
  toestemming.
- Het verwerken van één pagina kost op een laptop ongeveer twee seconden; op een
  telefoon is dat een paar keer zoveel. Het rechttrekken rekent elke pixel apart
  uit en dat blokkeert zolang het duurt het scherm.
