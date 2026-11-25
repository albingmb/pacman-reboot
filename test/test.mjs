// Test headless du wasm avec node : on branche des bouchons à la place du
// canvas, puis on vérifie le labyrinthe et on fait tourner une partie.
// Lancer : node test/test.mjs
import { readFile } from 'node:fs/promises';

const bytes = await readFile(new URL('../pacman.wasm', import.meta.url));

let nbClear = 0;
const sfxVus = [];
const env = {
  js_clear() { nbClear++; },
  js_pellet() {}, js_power() {}, js_pac() {}, js_ghost() {},
  js_sfx(id) { sfxVus.push(id); },
};

const { instance } = await WebAssembly.instantiate(bytes, { env });
const ex = instance.exports;

// 1) le labyrinthe, lu directement dans la mémoire du wasm
ex.init_game();
const mem = new Uint8Array(ex.memory.buffer);
const ptr = ex.get_maze();
const COLS = 28, ROWS = 31;
let gommes = 0, superGommes = 0;
for (let y = 0; y < ROWS; y++) {
  for (let x = 0; x < COLS; x++) {
    const c = mem[ptr + y * COLS + x];
    if (c === 0) throw new Error(`case vide (ligne courte ?) en ${x},${y}`);
    if (c === 46) gommes++;       // '.'
    if (c === 111) superGommes++; // 'o'
  }
}
if (superGommes !== 4) throw new Error(`attendu 4 super-gommes, trouvé ${superGommes}`);
if (gommes < 200) throw new Error(`trop peu de gommes: ${gommes}`);
console.log(`labyrinthe OK : ${gommes} gommes + ${superGommes} super-gommes`);

// 2) démarrage : PRET (0) -> JEU (1)
if (ex.get_state() !== 0) throw new Error('état initial devrait être PRET (0)');
ex.start();
ex.tick();
if (ex.get_state() !== 1) throw new Error('après start(), devrait être JEU (1)');
console.log('démarrage OK');

// 3) partie simulée avec des directions aléatoires : pas de crash, score > 0
const dirs = [0, 1, 2, 3];
let maxTicks = 200000;
let mortVus = 0;
let precedent = -1;
while (maxTicks-- > 0) {
  ex.set_dir(dirs[(Math.random() * 4) | 0]);
  ex.tick();
  const s = ex.get_state();
  if (s === 2 && precedent !== 2) mortVus++;
  precedent = s;
  if (s === 3) break; // GAME OVER
}
const score = ex.get_score();
if (score <= 0) throw new Error('le score devrait augmenter quand Pac-Man mange');
if (nbClear < 1000) throw new Error('le wasm devrait redessiner à chaque tick');
console.log(`partie OK : score=${score} vies=${ex.get_lives()} niveau=${ex.get_level()} morts=${mortVus} état=${ex.get_state()} ticks=${ex.get_tick()}`);
console.log(`sons entendus : ${sfxVus.length} (waka=${sfxVus.filter(i => i === 0).length})`);
console.log('✅ Tous les tests passent');
