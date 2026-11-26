// Test headless du wasm 3D avec node : labyrinthe cubique, deplacements 6D,
// invariant "jamais dans un mur", partie simulee.
// Lancer : node test/test.mjs
import { readFile } from 'node:fs/promises';

const bytes = await readFile(new URL('../pacman.wasm', import.meta.url));

const ghostList = [];
const sfxVus = [];
const env = {
  js_clear() { ghostList.length = 0; },
  js_ghost(x, y, z, c, m) { ghostList.push({ x, y, z, m }); },
  js_sfx(id) { sfxVus.push(id); },
};

const { instance } = await WebAssembly.instantiate(bytes, { env });
const ex = instance.exports;

// 1) le labyrinthe cubique, lu dans la memoire du wasm
ex.init_game();
const S = ex.get_size();
if (S !== 15) throw new Error(`taille cube attendue 15, trouvée ${S}`);
const ptr = ex.get_maze();
const mem = new Uint8Array(ex.memory.buffer);
const cell = (x, y, z) => mem[ptr + (z * S + y) * S + x];
// la coque externe doit etre un mur plein
for (let z = 0; z < S; z++)
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++)
      if (x === 0 || y === 0 || z === 0 || x === S - 1 || y === S - 1 || z === S - 1)
        if (cell(x, y, z) !== 35) throw new Error(`coque non mur en ${x},${y},${z}`);
let gommes = 0, superGommes = 0, vides = 0;
for (let i = 0; i < S * S * S; i++) {
  const c = mem[ptr + i];
  if (c === 0) throw new Error(`case non initialisée à l'index ${i}`);
  if (c === 46) gommes++;
  if (c === 111) superGommes++;
  if (c === 32) vides++;
}
if (superGommes !== 4) throw new Error(`attendu 4 super-gommes, trouvé ${superGommes}`);
if (gommes < 150) throw new Error(`trop peu de gommes: ${gommes}`);
console.log(`cube OK : ${S}^3 cases, ${gommes} gommes + ${superGommes} super-gommes, coque pleine`);

// 2) démarrage : PRET (0) -> JEU (1)
if (ex.get_state() !== 0) throw new Error('état initial devrait être PRET (0)');
ex.start();
ex.tick();
if (ex.get_state() !== 1) throw new Error('après start(), devrait être JEU (1)');
console.log('démarrage OK');

// 3) partie simulée en 6D : pas de crash, score > 0, jamais dans un mur
const moves = [0, 1, 2, 3, 4, 5, -1];
let maxTicks = 200000;
let mortVus = 0;
let precedent = -1;
while (maxTicks-- > 0) {
  ex.set_move(moves[(Math.random() * moves.length) | 0]);
  ex.tick();
  const s = ex.get_state();
  if (s === 2 && precedent !== 2) mortVus++;
  precedent = s;
  const m = new Uint8Array(ex.memory.buffer);
  const mur = (x, y, z) => m[ptr + (z * S + y) * S + x] === 35;
  if (s === 1) {
    const px = ex.get_px(), py = ex.get_py(), pz = ex.get_pz();
    if (mur(Math.floor(px / 16), Math.floor(py / 16), Math.floor(pz / 16)))
      throw new Error(`Pac-Man dans un mur à ${px},${py},${pz}`);
  }
  for (const g of ghostList)
    if (mur(Math.floor(g.x / 16), Math.floor(g.y / 16), Math.floor(g.z / 16)))
      throw new Error(`fantôme dans un mur à ${g.x},${g.y},${g.z}`);
  if (s === 3) break; // GAME OVER
}
const score = ex.get_score();
if (score <= 0) throw new Error('le score devrait augmenter quand Pac-Man mange');
console.log(`partie OK : score=${score} vies=${ex.get_lives()} niveau=${ex.get_level()} morts=${mortVus} état=${ex.get_state()} ticks=${ex.get_tick()}`);
console.log(`sons entendus : ${sfxVus.length} (waka=${sfxVus.filter(i => i === 0).length})`);
console.log('✅ Tous les tests passent');
