# 🟡 Pac-Man 3D — WebAssembly, vue subjective (POV)

Variante **3D** du clone de Pac-Man : le labyrinthe n'est plus une grille
2D mais un **cube 15×15×15 généré procéduralement à chaque niveau**, Pac-Man
se déplace en **6 directions** (haut/bas inclus) et on l'explore en
**première personne** (rendu par *raycasting* façon Wolfenstein).

Comme en 2D, **toute la logique tourne en WebAssembly** : le C
(`src/pacman.c`) est compilé en `pacman.wasm` (~20 Ko, aucune bibliothèque) ;
le JavaScript (`game.js`) ne fait que lire la position du joueur et le
labyrinthe dans la mémoire du wasm et projeter la scène 3D sur un canvas.

## 📁 Les fichiers

```
pacman-reboot/
├── index.html      # la page (à la racine = déploiement instantané)
├── game.js         # rendu 3D style Dungeon Master + HUD + clavier + sons
├── pacman.wasm     # le jeu compilé (déjà prêt)
├── src/pacman.c    # logique 3D en C (génération du cube, IA des fantômes…)
├── test/test.mjs   # test automatique avec node
└── build.sh        # recompile le wasm (optionnel)
```

Pour jouer : mettre en ligne **3 fichiers statiques** à la racine
(`index.html`, `game.js`, `pacman.wasm`).

## 🎮 Contrôles

| Touche | Action |
|---|---|
| `Z` / `↑` | avancer |
| `S` / `↓` | reculer |
| `Q` / `←` et `D` / `→` | pivoter de 90° |
| `E` / `C` | monter / descendre d'un étage (axe Z) |
| `W` / `X` | regarder en haut / en bas |
| `Entrée` / `Espace` | (re)démarrer |

Mange les 4 grosses gommes roses (dont une au centre du cube) pour rendre
les fantômes bleus et mangeables (200/400/800/1600 points). Chaque niveau
génère un **nouveau cube**.

## ▶️ Tester en local

```bash
python3 -m http.server 8000
# puis ouvrir http://localhost:8000
```

⚠️ Ne pas ouvrir `index.html` en `file://` : le navigateur bloque le
chargement du `.wasm` hors HTTP.

## 🚀 Déployer (au choix)

1. **GitHub Pages** : *Settings → Pages → Deploy from a branch → `main`
   (ou cette branche) → `/(root)` → Save* → URL
   `https://<pseudo>.github.io/pacman-reboot/`.
2. **Netlify Drop** : [app.netlify.com/drop](https://app.netlify.com/drop),
   glisser les 3 fichiers → URL publique instantanée.
3. **Vercel** : `npx vercel`.

## 🔧 Recompiler le wasm (optionnel)

```bash
pip install ziglang        # ou clang
./build.sh                 # produit pacman.wasm à la racine
```

## 🧪 Tests

```bash
node test/test.mjs
```

Vérifie la coque du cube, le nombre de gommes, et simule une partie en 6D
avec l'invariant « aucune entité ne traverse jamais un mur ».

## 🎮 Comment ça marche ?

- `src/pacman.c` génère le cube avec un *backtracker* 3D itératif (cases
  impaires + quelques murs cassés pour faire des boucles), place gommes,
  super-gommes et spawns.
- Déplacements en point fixe, pixel par pixel : la direction est choisie
  **au centre de la case avant de bouger**, donc on ne traverse jamais un mur.
- Les 4 fantômes gardent leur IA classique (Blinky poursuit, Pinky vise
  devant, Inky symétrique, Clyde alterne) mais en **6 directions** ; les
  yeux d'un fantôme mangé retournent à son spawn.
- `game.js` fait un **rendu 3D style Dungeon Master** : raycasting DDA pour
  les murs (texturés en briques avec joint entre chaque case, 8 niveaux
  d'ombrage selon la distance), floor-casting pour un **sol en damier**,
  plafond en dégradé, gommes et fantômes en sprites avec test d'occlusion,
  **mini-carte de l'étage courant** (position, cap, fantômes, gommes),
  vignette et viseur. Le cap pivote par pas de 90° (lisse à l'affichage)
  et `W`/`X` inclinent la vue (pitch).
