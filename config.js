/* Configuratie van de pakbon-app.
   Dit is het enige bestand dat je hoeft aan te passen. */

window.CONFIG = {
  // Waar de pakbonnen naartoe gaan.
  mailOntvanger: 'pakbonnen@witwognum.nl',
  mailOnderwerp: 'Pakbon',

  // Beeldbewerking.
  maxLangeZijde: 2400, // groter dan dit wordt teruggeschaald naar deze maat
  minLangeZijde: 2000, // nooit verder terugschalen dan dit
  jpegKwaliteit: 0.9,

  // Automatisch rechttrekken en uitsnijden.
  autoBijsnijden: true,
  randWerkbreedte: 320,  // op deze breedte wordt de rand gezocht
  randMarge: 0.01,       // hoeken iets naar buiten, zodat de rand niet wegvalt
  voorbeeldBreedte: 900, // grootte van het beeld in het bijsnijdscherm

  // Witbalans: welke pixels we als "papier" beschouwen (luminantie 0-255).
  papierMin: 150,
  papierMax: 252,
  maxKleurCorrectie: 0.25, // een kanaal mag hoogstens 25% op of af

  // Contrast.
  witPercentiel: 0.6, // 60e percentiel van de papierpixels wordt wit
  zwartPunt: 15,

  // Voorvoegsel van de bestandsnaam.
  bestandsVoorvoegsel: 'pakbon',
};
