# scorecheck – Scorebriefje Live

Webapp die handboog-scorebriefjes live via de camera controleert: de serie-score en het lopende totaal krijgen een overlay met *klopt*, *fout* (met de juiste waarde) of *nog invullen*.

Open de app: **https://lindende.github.io/scorecheck/**

- Alle herkenning draait op het toestel (OpenCV.js + een klein cijfermodel); er gaat geen beeld naar internet.
- Na het eerste bezoek werkt de app offline (service worker).
- Installeren op Android: open de link in Chrome → menu ⋮ → *App installeren*.

## Bijwerken

Na het vervangen van een bestand (bijvoorbeeld `weights.json` na hertrainen) het versienummer van `CACHE` in `sw.js` ophogen, anders blijven telefoons de oude versie uit de cache gebruiken.
