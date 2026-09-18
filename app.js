/* Pakbon-app. Alles draait in de browser: geen server, geen account.
   De foto's blijven op het toestel tot de medewerker ze opslaat. */

(function () {
  'use strict';

  var C = window.CONFIG;

  // ---------------------------------------------------------------- toestand

  // Een pagina bewaart het originele camerabestand (dat kost geen geheugen,
  // het is maar een verwijzing) plus de vier hoekpunten. Daardoor kunnen we
  // opnieuw uitsnijden vanaf de volle resolutie als de hoeken worden bijgesteld.
  var state = {
    paginas: [],      // { id, file, hoeken, modus, blob, url, voorbeeldUrl, ... }
    stempel: null,    // tijdstempel van deze pakbon, bij de eerste pagina gezet
    wachtrij: [],     // foto's die nog langs het bijsnijdscherm moeten
    volgnummer: 0,
  };

  var el = {};
  ['scherm-scannen','scherm-afronden','invoer-foto','invoer-vervang','knop-pagina',
   'status-verwerken','paginas','knop-naar-afronden','knop-terug','samenvatting',
   'bestandslijst','blok-verzenden','knop-verzenden','adres','knop-kopieer',
   'blok-reserve','knop-opslaan','knop-mail','status-delen','knop-nieuw','snijder',
   'snijder-doek','knop-snij-ok','knop-snij-annuleer'].forEach(function (id) {
    el[id] = document.getElementById(id);
  });

  function toon(naamVanScherm) {
    ['scherm-scannen','scherm-afronden'].forEach(function (s) {
      el[s].hidden = (s !== naamVanScherm);
    });
    window.scrollTo(0, 0);
  }

  // ------------------------------------------------------------- hulpstukken

  function klem(v, min, max) { return v < min ? min : (v > max ? max : v); }

  function luminantie(r, g, b) { return 0.299 * r + 0.587 * g + 0.114 * b; }

  // Even de beurt teruggeven aan de browser, zodat "Bezig met verwerken"
  // ook echt op het scherm komt voordat het rekenwerk begint.
  function wacht() {
    return new Promise(function (r) { setTimeout(r, 0); });
  }

  // createImageBitmap met imageOrientation 'from-image' draait de foto volgens
  // de EXIF-orientatie. Zonder dat staan liggende foto's op hun kant.
  function leesAfbeelding(file) {
    if (window.createImageBitmap) {
      try {
        return createImageBitmap(file, { imageOrientation: 'from-image' });
      } catch (e) { /* oudere browser: val terug op <img> */ }
    }
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('kan foto niet lezen')); };
      img.src = url;
    });
  }

  function naarBlob(canvas, kwaliteit) {
    return new Promise(function (resolve, reject) {
      canvas.toBlob(function (b) {
        b ? resolve(b) : reject(new Error('kan geen JPEG maken'));
      }, 'image/jpeg', kwaliteit);
    });
  }

  // Sterk verkleinen in één stap geeft kartelige letters; halveer daarom
  // stapsgewijs tot we dicht bij de doelmaat zitten.
  function tekenGeschaald(bron, bw, bh, doel) {
    var canvas = document.createElement('canvas');
    var w = bw, h = bh, huidig = bron;
    while (w / 2 >= doel.w && h / 2 >= doel.h) {
      w = Math.round(w / 2);
      h = Math.round(h / 2);
      var tussen = document.createElement('canvas');
      tussen.width = w; tussen.height = h;
      var tc = tussen.getContext('2d');
      tc.imageSmoothingEnabled = true;
      tc.imageSmoothingQuality = 'high';
      tc.drawImage(huidig, 0, 0, w, h);
      huidig = tussen;
    }
    canvas.width = doel.w;
    canvas.height = doel.h;
    var ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(huidig, 0, 0, doel.w, doel.h);
    return canvas;
  }

  // ------------------------------------------------------ rand van het papier

  // Drempel tussen licht en donker volgens Otsu: zoek de waarde waarbij het
  // verschil tussen beide groepen het grootst is.
  function otsu(hist, totaal) {
    var som = 0, i;
    for (i = 0; i < 256; i++) som += i * hist[i];
    var somAchter = 0, nAchter = 0, beste = 0, drempel = 128;
    for (i = 0; i < 256; i++) {
      nAchter += hist[i];
      if (nAchter === 0) continue;
      var nVoor = totaal - nAchter;
      if (nVoor === 0) break;
      somAchter += i * hist[i];
      var mAchter = somAchter / nAchter;
      var mVoor = (som - somAchter) / nVoor;
      var tussen = nAchter * nVoor * (mAchter - mVoor) * (mAchter - mVoor);
      if (tussen > beste) { beste = tussen; drempel = i; }
    }
    return drempel;
  }

  function oppervlak(p) { // schoenveterformule
    var o = 0;
    for (var i = 0; i < 4; i++) {
      var j = (i + 1) % 4;
      o += p[i].x * p[j].y - p[j].x * p[i].y;
    }
    return Math.abs(o) / 2;
  }

  function bol(p) { // alle bochten dezelfde kant op = geen geknakte vierhoek
    var teken = 0;
    for (var i = 0; i < 4; i++) {
      var a = p[i], b = p[(i + 1) % 4], c = p[(i + 2) % 4];
      var kruis = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
      if (kruis === 0) continue;
      var t = kruis > 0 ? 1 : -1;
      if (teken === 0) teken = t;
      else if (teken !== t) return false;
    }
    return true;
  }

  function afstand(a, b) { return Math.hypot(b.x - a.x, b.y - a.y); }

  // Zoek de vier hoeken van het papier. Werkwijze: verklein naar ~320 px,
  // splits licht van donker, neem het grootste aaneengesloten lichte gebied
  // (dat is het papier) en pak daarvan de vier uiterste punten. Geeft null
  // zodra iets niet klopt — liever niet uitsnijden dan verkeerd uitsnijden.
  function vindHoeken(bron) {
    var f = Math.min(1, C.randWerkbreedte / Math.max(bron.width, bron.height));
    var w = Math.max(8, Math.round(bron.width * f));
    var h = Math.max(8, Math.round(bron.height * f));
    var canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    var ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bron, 0, 0, w, h);
    var d = ctx.getImageData(0, 0, w, h).data;

    var totaal = w * h;
    var grijs = new Uint8Array(totaal);
    var hist = new Uint32Array(256);
    for (var i = 0, p = 0; p < totaal; i += 4, p++) {
      var l = luminantie(d[i], d[i + 1], d[i + 2]) | 0;
      grijs[p] = l;
      hist[l]++;
    }
    var drempel = otsu(hist, totaal);

    // Vlakvulling: elk licht gebied doorlopen en de uitersten meteen bijhouden.
    var bezocht = new Uint8Array(totaal);
    var stapel = new Int32Array(totaal);
    var beste = null;
    for (var start = 0; start < totaal; start++) {
      if (bezocht[start] || grijs[start] <= drempel) continue;
      var top = 0;
      stapel[top++] = start;
      bezocht[start] = 1;
      var n = 0;
      var minSom = 1e9, maxSom = -1e9, minVer = 1e9, maxVer = -1e9;
      var iLB = start, iRB = start, iRO = start, iLO = start;
      while (top > 0) {
        var q = stapel[--top];
        n++;
        var qx = q % w, qy = (q / w) | 0;
        var som = qx + qy, ver = qx - qy;
        if (som < minSom) { minSom = som; iLB = q; }   // linksboven
        if (som > maxSom) { maxSom = som; iRO = q; }   // rechtsonder
        if (ver > maxVer) { maxVer = ver; iRB = q; }   // rechtsboven
        if (ver < minVer) { minVer = ver; iLO = q; }   // linksonder
        if (qx > 0 && !bezocht[q - 1] && grijs[q - 1] > drempel) { bezocht[q - 1] = 1; stapel[top++] = q - 1; }
        if (qx < w - 1 && !bezocht[q + 1] && grijs[q + 1] > drempel) { bezocht[q + 1] = 1; stapel[top++] = q + 1; }
        if (qy > 0 && !bezocht[q - w] && grijs[q - w] > drempel) { bezocht[q - w] = 1; stapel[top++] = q - w; }
        if (qy < h - 1 && !bezocht[q + w] && grijs[q + w] > drempel) { bezocht[q + w] = 1; stapel[top++] = q + w; }
      }
      if (!beste || n > beste.n) beste = { n: n, hoeken: [iLB, iRB, iRO, iLO] };
    }
    if (!beste) return null;

    // Te klein is geen pakbon; bijna het hele beeld betekent dat het papier
    // en de ondergrond even licht zijn en we de rand dus niet zien.
    if (beste.n < 0.25 * totaal || beste.n > 0.97 * totaal) return null;

    var punten = beste.hoeken.map(function (q) {
      return { x: (q % w) + 0.5, y: ((q / w) | 0) + 0.5 };
    });

    // Het gevonden gebied moet ook echt vierhoekig zijn: bij een grillige vlek
    // is de vierhoek om de uitersten veel groter dan de vlek zelf.
    var opp = oppervlak(punten);
    if (opp < beste.n * 0.85 || opp > beste.n * 1.35) return null;
    if (!bol(punten)) return null;

    var kort = Math.min(w, h);
    for (var z = 0; z < 4; z++) {
      if (afstand(punten[z], punten[(z + 1) % 4]) < 0.2 * kort) return null;
    }
    var breed = (afstand(punten[0], punten[1]) + afstand(punten[3], punten[2])) / 2;
    var hoog = (afstand(punten[0], punten[3]) + afstand(punten[1], punten[2])) / 2;
    var verhouding = Math.max(breed, hoog) / Math.min(breed, hoog);
    if (verhouding > 5) return null;

    // Iets naar buiten schuiven, anders schaaf je de rand van de bon eraf.
    var mx = (punten[0].x + punten[1].x + punten[2].x + punten[3].x) / 4;
    var my = (punten[0].y + punten[1].y + punten[2].y + punten[3].y) / 4;
    return punten.map(function (q) {
      return {
        x: klem((q.x + (q.x - mx) * C.randMarge) / w, 0, 1),
        y: klem((q.y + (q.y - my) * C.randMarge) / h, 0, 1),
      };
    });
  }

  // ------------------------------------------------------------- rechttrekken

  // Projectieve afbeelding van het eenheidsvierkant naar de vierhoek, en dan
  // per doelpixel terugrekenen naar de bron (bilineair bemonsterd).
  function trekRecht(bronBeeld, doelBeeld, hoeken, sw, sh) {
    var x0 = hoeken[0].x * sw, y0 = hoeken[0].y * sh;
    var x1 = hoeken[1].x * sw, y1 = hoeken[1].y * sh;
    var x2 = hoeken[2].x * sw, y2 = hoeken[2].y * sh;
    var x3 = hoeken[3].x * sw, y3 = hoeken[3].y * sh;

    var dx1 = x1 - x2, dx2 = x3 - x2, dx3 = x0 - x1 + x2 - x3;
    var dy1 = y1 - y2, dy2 = y3 - y2, dy3 = y0 - y1 + y2 - y3;
    var a, b, c, dd, e, f, g, hh;
    var noemer = dx1 * dy2 - dx2 * dy1;
    if (dx3 === 0 && dy3 === 0) {
      g = 0; hh = 0;
      a = x1 - x0; b = x2 - x1; c = x0;
      dd = y1 - y0; e = y2 - y1; f = y0;
    } else {
      if (noemer === 0) return false;
      g = (dx3 * dy2 - dx2 * dy3) / noemer;
      hh = (dx1 * dy3 - dx3 * dy1) / noemer;
      a = x1 - x0 + g * x1; b = x3 - x0 + hh * x3; c = x0;
      dd = y1 - y0 + g * y1; e = y3 - y0 + hh * y3; f = y0;
    }

    var S = bronBeeld.data, D = doelBeeld.data;
    var W = doelBeeld.width, H = doelBeeld.height;
    var maxX = sw - 1.001, maxY = sh - 1.001;
    var o = 0;
    for (var j = 0; j < H; j++) {
      var v = (j + 0.5) / H;
      for (var i = 0; i < W; i++) {
        var u = (i + 0.5) / W;
        var t = g * u + hh * v + 1;
        var x = (a * u + b * v + c) / t;
        var y = (dd * u + e * v + f) / t;
        if (x < 0) x = 0; else if (x > maxX) x = maxX;
        if (y < 0) y = 0; else if (y > maxY) y = maxY;
        var fx = x | 0, fy = y | 0;
        var tx = x - fx, ty = y - fy;
        var k = (fy * sw + fx) * 4;
        var k2 = k + sw * 4;
        var w11 = (1 - tx) * (1 - ty), w21 = tx * (1 - ty);
        var w12 = (1 - tx) * ty, w22 = tx * ty;
        D[o] = S[k] * w11 + S[k + 4] * w21 + S[k2] * w12 + S[k2 + 4] * w22;
        D[o + 1] = S[k + 1] * w11 + S[k + 5] * w21 + S[k2 + 1] * w12 + S[k2 + 5] * w22;
        D[o + 2] = S[k + 2] * w11 + S[k + 6] * w21 + S[k2 + 2] * w12 + S[k2 + 6] * w22;
        D[o + 3] = 255;
        o += 4;
      }
    }
    return true;
  }

  // Snijd de vierhoek uit en trek hem recht. De bron wordt eerst op de maat
  // gebracht die we nodig hebben, zodat we nooit pixels verzinnen en het
  // geheugengebruik beperkt blijft.
  function snijdUit(bron, hoeken) {
    var pw = hoeken.map(function (p) { return { x: p.x * bron.width, y: p.y * bron.height }; });
    var breed = (afstand(pw[0], pw[1]) + afstand(pw[3], pw[2])) / 2;
    var hoog = (afstand(pw[0], pw[3]) + afstand(pw[1], pw[2])) / 2;
    if (!(breed > 8 && hoog > 8)) return null;

    var f = Math.min(1, C.maxLangeZijde / Math.max(breed, hoog));
    var dw = Math.max(1, Math.round(breed * f));
    var dh = Math.max(1, Math.round(hoog * f));
    var sw = Math.max(2, Math.round(bron.width * f));
    var sh = Math.max(2, Math.round(bron.height * f));

    var bronCanvas = tekenGeschaald(bron, bron.width, bron.height, { w: sw, h: sh });
    var bronBeeld = bronCanvas.getContext('2d', { willReadFrequently: true })
      .getImageData(0, 0, sw, sh);

    var doel = document.createElement('canvas');
    doel.width = dw; doel.height = dh;
    var dctx = doel.getContext('2d', { willReadFrequently: true });
    var doelBeeld = dctx.createImageData(dw, dh);
    if (!trekRecht(bronBeeld, doelBeeld, hoeken, sw, sh)) return null;
    dctx.putImageData(doelBeeld, 0, 0);
    return doel;
  }

  // ------------------------------------------------------------ kleur en licht

  // Stap 1 zonder uitsnijden: alleen terugschalen als de lange zijde groter is
  // dan het maximum, en nooit kleiner dan minLangeZijde.
  function doelMaat(w, h) {
    var lang = Math.max(w, h);
    if (lang <= C.maxLangeZijde) return { w: w, h: h };
    var doel = Math.max(C.maxLangeZijde, C.minLangeZijde);
    var f = doel / lang;
    return { w: Math.max(1, Math.round(w * f)), h: Math.max(1, Math.round(h * f)) };
  }

  function tabel(gain) {
    var lut = new Uint8ClampedArray(256);
    for (var v = 0; v < 256; v++) lut[v] = Math.round(v * gain);
    return lut;
  }

  // Witbalans. Het papier is het lichte vlak in de foto. We nemen de gemiddelde
  // R/G/B van die pixels en schalen de kanalen zo dat dat gemiddelde neutraal
  // grijs wordt. Zonder dit staat blauw al gauw 10 punten boven rood en oogt de
  // hele pakbon blauwig.
  function witbalans(data) {
    var n = 0, sr = 0, sg = 0, sb = 0;
    var stap = 4 * Math.max(1, Math.round(data.length / 4 / 200000)); // ~200k monsters
    for (var i = 0; i < data.length; i += stap) {
      var r = data[i], g = data[i + 1], b = data[i + 2];
      var l = luminantie(r, g, b);
      if (l >= C.papierMin && l <= C.papierMax) { n++; sr += r; sg += g; sb += b; }
    }
    if (n < 50) return; // te weinig papier gevonden: laat de kleuren met rust

    var ar = sr / n, ag = sg / n, ab = sb / n;
    var grijs = (ar + ag + ab) / 3;
    var laag = 1 - C.maxKleurCorrectie, hoog = 1 + C.maxKleurCorrectie;
    var lutR = tabel(klem(grijs / ar, laag, hoog));
    var lutG = tabel(klem(grijs / ag, laag, hoog));
    var lutB = tabel(klem(grijs / ab, laag, hoog));
    for (var j = 0; j < data.length; j += 4) {
      data[j] = lutR[data[j]];
      data[j + 1] = lutG[data[j + 1]];
      data[j + 2] = lutB[data[j + 2]];
    }
  }

  // Contrast. Het 60e percentiel van de papierpixels wordt wit, het zwartpunt
  // ligt rond 15. Per pagina apart berekend, zodat verschillen in lichtval
  // tussen foto's verdwijnen en de inkt blijft staan.
  function contrast(data) {
    var hist = new Uint32Array(256), n = 0;
    for (var i = 0; i < data.length; i += 4) {
      var l = Math.round(luminantie(data[i], data[i + 1], data[i + 2]));
      if (l >= C.papierMin && l <= C.papierMax) { hist[l]++; n++; }
    }

    var wit = 235; // bij te weinig papier: een nuchtere standaardwaarde
    if (n >= 50) {
      var grens = n * C.witPercentiel, som = 0;
      for (var v = 0; v < 256; v++) {
        som += hist[v];
        if (som >= grens) { wit = v; break; }
      }
    }
    var zwart = C.zwartPunt;
    if (wit < zwart + 40) wit = zwart + 40; // nooit zo hard dat alles dichtslaat

    var lut = new Uint8ClampedArray(256);
    for (var w = 0; w < 256; w++) lut[w] = Math.round((w - zwart) * 255 / (wit - zwart));
    for (var j = 0; j < data.length; j += 4) {
      data[j] = lut[data[j]];
      data[j + 1] = lut[data[j + 1]];
      data[j + 2] = lut[data[j + 2]];
    }
  }

  // ------------------------------------------------------------- de lopende band

  function heleFoto() {
    return [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
  }

  // Eerste ronde: foto lezen, een klein voorbeeld maken en de rand zoeken.
  // Hier wordt nog niets uitgesneden — dat gebeurt pas als de medewerker de
  // gevonden hoeken heeft gezien. Dit deel is licht, zodat het bijsnijdscherm
  // meteen na het fotograferen op het scherm staat.
  function verken(file) {
    return leesAfbeelding(file).then(function (bron) {
      return wacht().then(function () {
        var hoeken = C.autoBijsnijden ? vindHoeken(bron) : null;

        // Onbewerkt voorbeeld: daarop is de rand van het papier beter te
        // beoordelen dan op een opgepoetste versie.
        var v = Math.min(1, C.voorbeeldBreedte / Math.max(bron.width, bron.height));
        var voorbeeld = tekenGeschaald(bron, bron.width, bron.height, {
          w: Math.max(1, Math.round(bron.width * v)),
          h: Math.max(1, Math.round(bron.height * v)),
        });

        return naarBlob(voorbeeld, 0.8).then(function (vb) {
          var uit = {
            file: file,
            bronW: bron.width,
            bronH: bron.height,
            hoeken: hoeken || heleFoto(),
            modus: hoeken ? 'auto' : 'geen',
            voorbeeldUrl: URL.createObjectURL(vb),
            eigenVoorbeeld: true,
          };
          if (bron.close) bron.close();
          return uit;
        });
      });
    });
  }

  // Tweede ronde, met de hoeken die op het scherm stonden.
  // Volgorde: uitsnijden en rechttrekken, dan schalen, dan witbalans, dan
  // contrast. Uitsnijden gaat voorop zodat de kleurmetingen alleen over het
  // papier gaan en niet over de ondergrond.
  function verwerk(file, hoeken) {
    var uit = {};
    return leesAfbeelding(file).then(function (bron) {
      return wacht().then(function () {
        uit.bronW = bron.width;
        uit.bronH = bron.height;
        uit.hoeken = hoeken;

        var canvas = snijdUit(bron, hoeken);
        if (!canvas) {
          canvas = tekenGeschaald(bron, bron.width, bron.height,
            doelMaat(bron.width, bron.height));
        }

        var ctx = canvas.getContext('2d', { willReadFrequently: true });
        var beeld = ctx.getImageData(0, 0, canvas.width, canvas.height);
        witbalans(beeld.data);
        contrast(beeld.data);
        ctx.putImageData(beeld, 0, 0);
        uit.uitW = canvas.width;
        uit.uitH = canvas.height;

        return naarBlob(canvas, C.jpegKwaliteit).then(function (blob) {
          uit.blob = blob;
          uit.url = URL.createObjectURL(blob);
          if (bron.close) bron.close();
          return uit;
        });
      });
    });
  }

  // ------------------------------------------------------- pagina's beheren

  function vindPagina(id) {
    for (var i = 0; i < state.paginas.length; i++) {
      if (state.paginas[i].id === id) return state.paginas[i];
    }
    return null;
  }

  function ruimOp(p) {
    if (p.url) URL.revokeObjectURL(p.url);
    if (p.voorbeeldUrl) URL.revokeObjectURL(p.voorbeeldUrl);
  }

  // Nieuwe foto's gaan één voor één langs het bijsnijdscherm. Pas als de
  // hoeken akkoord zijn wordt de pagina echt gemaakt en in de lijst gezet.
  function voegToe(files) {
    if (!files || !files.length) return;
    state.wachtrij = state.wachtrij.concat(Array.prototype.slice.call(files));
    volgendeFoto();
  }

  function volgendeFoto(vervangId) {
    if (!state.wachtrij.length) return;
    var file = state.wachtrij.shift();
    bezig(true);
    verken(file).then(function (v) {
      bezig(false);
      openSnijder(v, vervangId || null);
    }).catch(function (e) {
      bezig(false);
      fout(e);
      volgendeFoto();
    });
  }

  // Uitsnijden vanaf het originele camerabestand, dus zonder kwaliteitsverlies
  // ten opzichte van de eerste keer. vervangId leeg = nieuwe pagina erbij.
  function legVast(verkenning, hoeken, aangepast, vervangId) {
    if (!state.stempel) state.stempel = nu();
    bezig(true);
    verwerk(verkenning.file, hoeken).then(function (uit) {
      uit.file = verkenning.file;
      uit.voorbeeldUrl = verkenning.voorbeeldUrl;
      uit.modus = aangepast ? 'hand' : verkenning.modus;

      var oud = vervangId ? vindPagina(vervangId) : null;
      if (oud) {
        if (oud.voorbeeldUrl !== uit.voorbeeldUrl) URL.revokeObjectURL(oud.voorbeeldUrl);
        URL.revokeObjectURL(oud.url);
        uit.id = oud.id;
        state.paginas[state.paginas.indexOf(oud)] = uit;
      } else {
        uit.id = 'p' + (++state.volgnummer);
        state.paginas.push(uit);
      }
      tekenPaginas();
    }).catch(fout).then(function () {
      bezig(false);
      volgendeFoto(); // bij meerdere foto's tegelijk meteen de volgende
    });
  }

  function verwijder(id) {
    var p = vindPagina(id);
    if (!p) return;
    var i = state.paginas.indexOf(p);
    if (!confirm('Pagina ' + (i + 1) + ' verwijderen?')) return;
    ruimOp(p);
    state.paginas.splice(i, 1);
    if (!state.paginas.length) state.stempel = null;
    tekenPaginas();
  }

  function bezig(aan) {
    el['status-verwerken'].hidden = !aan;
    el['knop-pagina'].disabled = aan;
  }

  function fout(e) {
    console.error(e);
    alert('Er ging iets mis bij het verwerken van de foto:\n' + (e && e.message ? e.message : e));
  }

  var MODUS_TEKST = {
    auto: 'automatisch rechtgetrokken',
    hand: 'hoeken met de hand gezet',
    geen: 'rand niet gevonden — hele foto bewaard',
  };

  function tekenPaginas() {
    var doel = el['paginas'];
    doel.textContent = '';

    state.paginas.forEach(function (p, i) {
      var rij = document.createElement('div');
      rij.className = 'pagina';

      var img = document.createElement('img');
      img.src = p.url;
      img.alt = 'Pagina ' + (i + 1);
      rij.appendChild(img);

      var info = document.createElement('div');
      info.className = 'pagina-info';

      var titel = document.createElement('div');
      titel.className = 'titel';
      titel.textContent = 'Pagina ' + (i + 1);
      info.appendChild(titel);

      // Resolutie zichtbaar houden: zo zien we tijdens het testen wat de
      // camera van dit toestel werkelijk levert.
      var meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = 'camera ' + p.bronW + '×' + p.bronH +
        ' → opgeslagen ' + p.uitW + '×' + p.uitH +
        ' · ' + Math.round(p.blob.size / 1024) + ' kB';
      info.appendChild(meta);

      var snit = document.createElement('div');
      snit.className = 'meta' + (p.modus === 'geen' ? ' waarschuwing' : '');
      snit.textContent = MODUS_TEKST[p.modus] || '';
      info.appendChild(snit);

      if (Math.min(p.uitW, p.uitH) < 1700 || Math.max(p.uitW, p.uitH) < 2400) {
        var waarschuwing = document.createElement('div');
        waarschuwing.className = 'meta waarschuwing';
        waarschuwing.textContent = 'Let op: lager dan 1700×2400. Handschrift kan onleesbaar zijn.';
        info.appendChild(waarschuwing);
      }

      var knoppen = document.createElement('div');
      knoppen.className = 'pagina-knoppen';
      knoppen.appendChild(knop('Bijsnijden', 'knop klein secundair', function () {
        openSnijder({
          file: p.file, bronW: p.bronW, bronH: p.bronH,
          hoeken: p.hoeken, modus: p.modus, voorbeeldUrl: p.voorbeeldUrl,
          eigenVoorbeeld: false,
        }, p.id);
      }));
      knoppen.appendChild(knop('Opnieuw', 'knop klein secundair', function () {
        snijder.vervangNa = p.id;
        el['invoer-vervang'].value = '';
        el['invoer-vervang'].click();
      }));
      knoppen.appendChild(knop('Verwijderen', 'knop klein plat', function () {
        verwijder(p.id);
      }));
      info.appendChild(knoppen);

      rij.appendChild(info);
      doel.appendChild(rij);
    });

    el['knop-naar-afronden'].disabled = state.paginas.length === 0;
  }

  function knop(tekst, klasse, opklik) {
    var b = document.createElement('button');
    b.className = klasse;
    b.textContent = tekst;
    b.addEventListener('click', opklik);
    return b;
  }

  // ------------------------------------------------------ bijsnijden met de hand

  var snijder = {
    verkenning: null, // de foto die op het scherm staat
    vervangId: null,  // pagina die vervangen wordt, leeg bij een nieuwe foto
    vervangNa: null,  // pagina waarvoor "Opnieuw" is aangetikt
    img: null, hoeken: null, aangepast: false, sleept: -1, breed: 0, hoog: 0,
  };

  function openSnijder(verkenning, vervangId) {
    snijder.verkenning = verkenning;
    snijder.vervangId = vervangId || null;
    snijder.hoeken = verkenning.hoeken.map(function (q) { return { x: q.x, y: q.y }; });
    snijder.aangepast = false;
    snijder.sleept = -1;
    var img = new Image();
    img.onload = function () { snijder.img = img; pasDoekAan(); };
    img.src = verkenning.voorbeeldUrl;
    // Bij een pas gemaakte foto is annuleren hetzelfde als weggooien; bij een
    // bestaande pagina laat het alles staan zoals het was.
    el['knop-snij-annuleer'].textContent = (verkenning.eigenVoorbeeld && !vervangId)
      ? 'Foto weggooien' : 'Annuleren';
    el['snijder'].hidden = false;
    document.body.style.overflow = 'hidden';
  }

  function sluitSnijder() {
    el['snijder'].hidden = true;
    document.body.style.overflow = '';
    snijder.verkenning = null;
    snijder.vervangId = null;
    snijder.img = null;
  }

  function pasDoekAan() {
    var doek = el['snijder-doek'];
    if (!snijder.img) return;
    var beschikbaarB = doek.parentNode.clientWidth;
    var beschikbaarH = window.innerHeight - 200;
    var verhouding = snijder.img.width / snijder.img.height;
    var b = beschikbaarB;
    var h = b / verhouding;
    if (h > beschikbaarH) { h = beschikbaarH; b = h * verhouding; }
    snijder.breed = Math.round(b);
    snijder.hoog = Math.round(h);
    var dpr = window.devicePixelRatio || 1;
    doek.style.width = snijder.breed + 'px';
    doek.style.height = snijder.hoog + 'px';
    doek.width = Math.round(snijder.breed * dpr);
    doek.height = Math.round(snijder.hoog * dpr);
    tekenSnijder();
  }

  function tekenSnijder() {
    var doek = el['snijder-doek'];
    if (!snijder.img) return;
    var ctx = doek.getContext('2d');
    var dpr = doek.width / snijder.breed;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, snijder.breed, snijder.hoog);
    ctx.drawImage(snijder.img, 0, 0, snijder.breed, snijder.hoog);

    var p = snijder.hoeken.map(function (q) {
      return { x: q.x * snijder.breed, y: q.y * snijder.hoog };
    });

    // Alles buiten de vierhoek dempen, zodat meteen zichtbaar is wat wegvalt.
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, snijder.breed, snijder.hoog);
    ctx.moveTo(p[0].x, p[0].y);
    for (var i = 3; i >= 1; i--) ctx.lineTo(p[i].x, p[i].y);
    ctx.closePath();
    ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
    ctx.fill('evenodd');
    ctx.restore();

    ctx.beginPath();
    ctx.moveTo(p[0].x, p[0].y);
    for (var j = 1; j < 4; j++) ctx.lineTo(p[j].x, p[j].y);
    ctx.closePath();
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#f9a13a';
    ctx.stroke();

    for (var k = 0; k < 4; k++) {
      ctx.beginPath();
      ctx.arc(p[k].x, p[k].y, 16, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
      ctx.fill();
      ctx.lineWidth = 4;
      ctx.strokeStyle = '#005837';
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(p[k].x, p[k].y, 3, 0, Math.PI * 2);
      ctx.fillStyle = '#005837';
      ctx.fill();
    }
  }

  function doekPositie(e) {
    var r = el['snijder-doek'].getBoundingClientRect();
    return {
      x: klem((e.clientX - r.left) / r.width, 0, 1),
      y: klem((e.clientY - r.top) / r.height, 0, 1),
    };
  }

  function omlaag(e) {
    if (!snijder.img) return;
    var pos = doekPositie(e);
    var beste = -1, kortst = 1e9;
    for (var i = 0; i < 4; i++) {
      var dx = (snijder.hoeken[i].x - pos.x) * snijder.breed;
      var dy = (snijder.hoeken[i].y - pos.y) * snijder.hoog;
      var d = Math.hypot(dx, dy);
      if (d < kortst) { kortst = d; beste = i; }
    }
    if (kortst > 60) return; // ruime greep, ook met handschoenen
    snijder.sleept = beste;
    try { el['snijder-doek'].setPointerCapture(e.pointerId); } catch (x) { /* niet essentieel */ }
    e.preventDefault();
  }

  function beweeg(e) {
    if (snijder.sleept < 0) return;
    snijder.hoeken[snijder.sleept] = doekPositie(e);
    snijder.aangepast = true;
    tekenSnijder();
    e.preventDefault();
  }

  function omhoog() { snijder.sleept = -1; }

  // ----------------------------------------------------- 3. bestanden opslaan

  function nu() {
    var d = new Date();
    var p = function (n) { return String(n).padStart(2, '0'); };
    return {
      datum: d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()),
      tijd: p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()),
    };
  }

  // pakbon-JJJJ-MM-DD-uummss-p1.jpg. Wie hem stuurde blijkt uit het
  // afzenderadres van de mail, dus dat hoeft niet meer in de naam.
  function bestandsnaam(index) {
    var s = state.stempel || nu();
    return [C.bestandsVoorvoegsel, s.datum, s.tijd].join('-') +
      '-p' + (index + 1) + '.jpg';
  }

  function tekenAfronden() {
    melding('');
    el['samenvatting'].textContent = state.paginas.length +
      (state.paginas.length === 1 ? ' pagina' : ' pagina’s') +
      ' — elke pagina wordt een apart bestand.';

    var lijst = el['bestandslijst'];
    lijst.textContent = '';
    state.paginas.forEach(function (p, i) {
      var li = document.createElement('li');
      var a = document.createElement('a');
      a.href = p.url;
      a.download = bestandsnaam(i);
      a.textContent = bestandsnaam(i);
      li.appendChild(a);
      lijst.appendChild(li);
    });
  }

  // Een mailto-link kan ontvanger en onderwerp invullen, maar géén bijlagen
  // meenemen: browsers staan dat niet toe. Daarom slaat de app de foto's eerst
  // op, zodat ze in de mailapp met de paperclip te pakken zijn.
  function mailLink() {
    // Het adres bewust niet coderen: sommige mailapps struikelen over %40.
    return 'mailto:' + C.mailOntvanger +
      '?subject=' + encodeURIComponent(C.mailOnderwerp) +
      '&body=' + encodeURIComponent(
        'Voeg de zojuist opgeslagen foto’s toe met de paperclip:\n\n' +
        state.paginas.map(function (p, i) { return bestandsnaam(i); }).join('\n') +
        '\n');
  }

  // Opslaan en daarna de mail openen. De pauze ertussen is nodig omdat een
  // telefoon de downloads afbreekt zodra hij naar de mailapp springt. De mail
  // gaat via een aangeklikte link: dat slikken iPhones beter dan het zetten
  // van location.href buiten een tik om.
  function zetMailKlaar() {
    if (!state.paginas.length) return;
    melding('Foto’s worden opgeslagen…');
    slaOp();
    var wachten = 500 + state.paginas.length * 300;
    setTimeout(function () {
      melding('Mail staat klaar. Voeg de foto’s toe met de paperclip.');
      var a = document.createElement('a');
      a.href = mailLink();
      a.id = 'mail-link';
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { a.remove(); }, 2000);
    }, wachten);
  }

  // Verzenden gaat via het deelmenu van de telefoon: daar gaan de foto's wél
  // als bijlage mee. De ontvanger kan een deelmenu niet meekrijgen, dus die
  // staat op het scherm om te kopiëren.
  function kanDelen() {
    if (!navigator.share || !navigator.canShare) return false;
    try {
      var proef = new File([new Blob(['x'])], 'proef.jpg', { type: 'image/jpeg' });
      return navigator.canShare({ files: [proef] });
    } catch (e) {
      return false;
    }
  }

  function melding(tekst) {
    el['status-delen'].textContent = tekst;
    el['status-delen'].hidden = !tekst;
  }

  function verzend() {
    if (!state.paginas.length) return;
    var bestanden = state.paginas.map(function (p, i) {
      return new File([p.blob], bestandsnaam(i), { type: 'image/jpeg' });
    });
    if (!navigator.canShare || !navigator.canShare({ files: bestanden })) {
      melding('Verzenden lukt niet op dit toestel. Sla de foto’s op en mail ze zelf.');
      return;
    }
    melding('');
    // De meeste mailapps nemen 'title' over als onderwerp en 'text' als tekst.
    // navigator.share moet meteen bij de tik gebeuren, zonder wachten ervoor.
    navigator.share({
      files: bestanden,
      title: C.mailOnderwerp,
      text: C.mailOnderwerp,
    }).then(function () {
      melding('Doorgegeven aan je mailapp. Controleer of de mail echt verstuurd is.');
    }).catch(function (e) {
      if (e && e.name === 'AbortError') return; // zelf afgebroken, geen fout
      melding('Verzenden is niet gelukt: ' + (e && e.message ? e.message : e));
    });
  }

  function kopieerAdres() {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(C.mailOntvanger).then(function () {
        melding('Adres gekopieerd. Plak het in het veld "Aan".');
      }).catch(function () {
        melding('Kopiëren lukt niet; neem het adres hierboven over.');
      });
    } else {
      melding('Kopiëren lukt niet op dit toestel; neem het adres hierboven over.');
    }
  }

  // Eén download per pagina. Browsers slikken meerdere downloads achter elkaar
  // alleen met een kleine tussenpoos; daarom de vertraging.
  function slaOp() {
    if (!state.paginas.length) return;
    el['knop-opslaan'].disabled = true;
    state.paginas.forEach(function (p, i) {
      setTimeout(function () {
        var a = document.createElement('a');
        a.href = p.url;
        a.download = bestandsnaam(i);
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        if (i === state.paginas.length - 1) {
          setTimeout(function () { el['knop-opslaan'].disabled = false; }, 300);
        }
      }, i * 400);
    });
  }

  function nieuw() {
    if (state.paginas.length && !confirm('Alle pagina’s wissen en opnieuw beginnen?')) return;
    state.paginas.forEach(ruimOp);
    state.paginas = [];
    state.stempel = null;
    tekenPaginas();
    toon('scherm-scannen');
  }

  // ------------------------------------------------------------- vastknopen

  el['knop-pagina'].addEventListener('click', function () {
    el['invoer-foto'].value = '';
    el['invoer-foto'].click();
  });
  el['invoer-foto'].addEventListener('change', function (e) { voegToe(e.target.files); });
  el['invoer-vervang'].addEventListener('change', function (e) {
    var id = snijder.vervangNa;
    snijder.vervangNa = null;
    if (!e.target.files[0] || !id) return;
    state.wachtrij.push(e.target.files[0]);
    volgendeFoto(id);
  });

  el['snijder-doek'].addEventListener('pointerdown', omlaag);
  el['snijder-doek'].addEventListener('pointermove', beweeg);
  el['snijder-doek'].addEventListener('pointerup', omhoog);
  el['snijder-doek'].addEventListener('pointercancel', omhoog);
  window.addEventListener('resize', function () { if (!el['snijder'].hidden) pasDoekAan(); });

  el['knop-snij-ok'].addEventListener('click', function () {
    var v = snijder.verkenning, hoeken = snijder.hoeken;
    var aangepast = snijder.aangepast, vervangId = snijder.vervangId;
    if (!v) return;
    sluitSnijder();
    legVast(v, hoeken, aangepast, vervangId);
  });

  el['knop-snij-annuleer'].addEventListener('click', function () {
    var v = snijder.verkenning;
    sluitSnijder();
    // Een pas gemaakte foto die nog geen pagina is, verdwijnt met het scherm.
    if (v && v.eigenVoorbeeld) URL.revokeObjectURL(v.voorbeeldUrl);
    volgendeFoto();
  });

  el['knop-naar-afronden'].addEventListener('click', function () {
    tekenAfronden();
    toon('scherm-afronden');
  });
  el['knop-terug'].addEventListener('click', function () { toon('scherm-scannen'); });
  el['knop-opslaan'].addEventListener('click', slaOp);
  el['knop-verzenden'].addEventListener('click', verzend);
  el['knop-kopieer'].addEventListener('click', kopieerAdres);
  el['knop-mail'].addEventListener('click', zetMailKlaar);

  // Delen met bijlagen kan alleen als het toestel dat ondersteunt.
  el['adres'].textContent = C.mailOntvanger;
  el['blok-verzenden'].hidden = !kanDelen();
  el['knop-nieuw'].addEventListener('click', nieuw);

  // De pagina's staan alleen in het geheugen: waarschuw bij per ongeluk sluiten.
  window.addEventListener('beforeunload', function (e) {
    if (state.paginas.length) { e.preventDefault(); e.returnValue = ''; }
  });

  // ------------------------------------------------------------------ start

  // Geen naam, geen pincode: de app staat meteen klaar om te fotograferen.
  toon('scherm-scannen');

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function (e) {
        console.warn('service worker niet geregistreerd', e);
      });
    });
  }
})();
