NEURONI NEXUS V5 – TASOHAKU + ISO PÄIVITYS

Uutta:
- Etsi saman tasoinen pelaaja -pikahaku oikean Socket.IO-palvelimen kautta
- haku vertaa sekä tasoa että ratingia
- hakualuetta kasvatetaan hitaasti, jos ketään ei löydy
- XP, tasot 1–99, rating ja rankit
- voittoputki, paras putki ja viiden viime ottelun historia
- päivän bonus: 50 kolikkoa + 20 XP
- harjoitusbotin vaikeus mukautuu pelaajan tasoon
- uudet nopeus- ja kilpibonukset areenalle
- matalan elämän varoitusefekti
- puhelimen joystick, AMMU, E ja Q säilyvät
- huonekoodilla pelaaminen säilyy

PÄIVITÄ GITHUBISSA NÄMÄ KAIKKI:
- index.html
- server.js
- package.json
- package-lock.json
- render.yaml

Render-asetukset:
Build Command: npm install
Start Command: node server.js
Root Directory: jätä tyhjäksi

Kun GitHubiin tulee uusi commit, Render tekee yleensä uuden deployn automaattisesti.
Tarvittaessa paina Renderissä Manual Deploy -> Clear build cache & deploy.

Testiosoite palvelimelle:
/health
Siinä pitäisi näkyä ok:true sekä waitingPlayers-luku.
