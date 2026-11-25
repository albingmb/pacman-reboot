# 🟡 Pac-Man en WebAssembly

Un clone de Pac-Man dont **toute la logique du jeu tourne en WebAssembly** :
le code du jeu est écrit en C (`src/pacman.c`), compilé en un petit fichier
`pacman.wasm` (~19 Ko, aucune bibliothèque, aucun framework), et le
JavaScript (`game.js`) ne fait que charger le wasm, dessiner sur un canvas
et transmettre les touches du clavier.

## 📁 Les fichiers

```
pacman-reboot/
├── index.html      # la page (à la racine = déploiement instantané)
├── game.js         # charge le wasm + dessine + clavier + sons
├── pacman.wasm     # le jeu compilé (déjà prêt, pas besoin de recompiler)
├── src/pacman.c    # toute la logique du jeu (en C)
├── test/test.mjs   # test automatique avec node
└── build.sh        # recompile le wasm (optionnel)
```

Pour jouer, il suffit de mettre en ligne **3 fichiers statiques** à la
racine : `index.html`, `game.js`, `pacman.wasm`.

## ▶️ Tester en local (2 minutes)

Un navigateur refuse de charger un `.wasm` si on ouvre la page avec
`file://...` : il faut passer par un petit serveur HTTP local.

```bash
python3 -m http.server 8000
```

Puis ouvre **http://localhost:8000** dans ton navigateur.

(Avec Node : `npx serve .` fait pareil.)

**Contrôles** : flèches directionnelles (ou Z/Q/S/D), Entrée ou Espace pour
(re)démarrer. Mange les 4 grosses gommes roses pour rendre les fantômes
bleus et mangeables.

## 🚀 Déployer sur Internet (choisis UNE méthode)

### Méthode 1 — GitHub Pages (gratuit, recommandé pour débuter)

Les 3 fichiers web sont déjà à la racine du dépôt, donc :

1. Dans ce dépôt : *Settings* (⚙️ en haut) → *Pages* (menu de gauche).
2. *Build and deployment* : *Source* = **Deploy from a branch**,
   *Branch* = `main`, dossier = `/(root)`, puis *Save*.
3. Attends 1–2 minutes : GitHub affiche l'URL, du type
   **https://`<ton-pseudo>`.github.io/pacman-reboot/** → partage-la !

### Méthode 2 — Netlify Drop (le plus simple, zéro configuration)

1. Va sur [app.netlify.com/drop](https://app.netlify.com/drop).
2. Glisse-dépose le contenu du dépôt (ou juste les 3 fichiers
   `index.html`, `game.js`, `pacman.wasm`) dans la page.
3. Netlify te donne immédiatement une URL publique du type
   `https://<nom-aléatoire>.netlify.app` → ton jeu est en ligne.

### Méthode 3 — Vercel

```bash
npx vercel
```
(suis les questions, choisis le nom du projet → URL publique donnée à la fin).

> ⚠️ Important : ne double-clique jamais sur `index.html` (file://) pour
> "tester en ligne" — le wasm ne se chargera pas. Utilise toujours une URL
> en `http://localhost:...` ou `https://...`.

## 🔧 Recompiler le wasm (optionnel)

Le fichier `pacman.wasm` est déjà compilé, donc cette étape n'est utile
que si tu modifies `src/pacman.c` :

```bash
pip install ziglang        # ou installe clang
./build.sh                 # produit pacman.wasm à la racine
```

## 🧪 Tester la logique sans navigateur

```bash
node test/test.mjs
```

## 🎮 Comment ça marche ?

- Le C est compilé vers la cible `wasm32` : le navigateur exécute le binaire
  wasm à quasi vitesse native.
- Le wasm **importe** 6 fonctions du JS (`js_clear`, `js_pellet`,
  `js_power`, `js_pac`, `js_ghost`, `js_sfx`) pour se faire dessiner, et
  **exporte** l'API du jeu (`tick`, `set_dir`, `start`, `get_score`, ...).
- `game.js` fait tourner `tick()` 60 fois par seconde et lit le score, les
  vies, le niveau et l'état via les fonctions `get_*`.
- Les 4 fantômes ont leur IA classique : Blinky poursuit Pac-Man, Pinky
  vise devant lui, Inky fait le symétrique via Blinky, Clyde alterne
  poursuite/coin. Super-gomme = fantômes bleus et mangeables (200/400/800/1600
  points), tunnel latéral, niveaux infinis.
