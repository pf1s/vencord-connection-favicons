# ConnectionFavicons

Plugin [Vencord](https://vencord.dev) qui remplace l'icône générique des connexions **« Domaine »** sur les profils Discord par le vrai favicon du site.

Tous les formats courants sont pris en charge (SVG, PNG, ICO, WebP, GIF, JPEG, AVIF) : le plugin lit les `<link rel="icon">` de la page d'accueil du site et choisit le meilleur, avec `/favicon.ico` en dernier recours.

## Installation

Il faut une installation de Vencord [compilée depuis les sources](https://docs.vencord.dev/installing/custom-plugins/).

```sh
cd <dossier-Vencord>/src/userplugins
git clone https://github.com/pf1s/vencord-connection-favicons.git connectionFavicons
cd ../.. && pnpm build && pnpm inject
```

Redémarre complètement Discord, puis active **ConnectionFavicons** dans les réglages de Vencord.

## Fonctionnement

- Sur Discord desktop et Vesktop, les favicons sont récupérés par le processus principal (`native.ts`), sans passer par un service tiers. Les résultats sont gardés en cache 6 h.
- Sur la version web de Discord, le plugin utilise le service de favicons de DuckDuckGo (fichiers `.ico` uniquement).
- Si aucun favicon n'est trouvé, l'icône Discord d'origine est conservée.

## Sécurité et vie privée

- Ton client contacte directement chaque site affiché dans un profil : ces sites voient ton adresse IP.
- Seul le HTTPS est accepté, et tout domaine qui pointe vers une adresse privée ou locale est refusé, la vérification se faisant au moment de la connexion.
- Les réponses sont limitées en taille, en durée et en nombre de redirections.
- Les SVG sont affichés dans un `<img>`, où ils ne peuvent exécuter aucun script.

## Licence

GPL-3.0-or-later, comme Vencord.
