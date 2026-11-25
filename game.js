/*
 * Charge pacman.wasm, branche les fonctions de dessin importees par le wasm
 * (env.js_*) et fait tourner la boucle de jeu a 60 ticks/seconde.
 * Le wasm contient TOUTE la logique ; ce fichier ne fait qu'afficher.
 */
'use strict';
(() => {
  const COLS = 28, ROWS = 31, TILE = 16;
  const W = COLS * TILE, H = ROWS * TILE; // 448 x 496

  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  const scoreEl = document.getElementById('score');
  const niveauEl = document.getElementById('niveau');
  const viesEl = document.getElementById('vies');
  const erreurEl = document.getElementById('erreur');

  let ex = null;    // exports du module wasm
  let tick = 0;     // nombre de ticks joues (animations)
  let murs = null;  // image des murs, construite une fois
  let waka = false; // alternance du son "waka"
  let ac = null;    // AudioContext (lazy)

  /* --- petits sons en WebAudio --- */
  function sfx(id) {
    try {
      if (!ac) ac = new (window.AudioContext || window.webkitAudioContext)();
      if (ac.state === 'suspended') ac.resume();
      const t = ac.currentTime;
      const o = ac.createOscillator();
      const g = ac.createGain();
      o.connect(g); g.connect(ac.destination);
      let f0 = 440, f1 = 440, duree = 0.08, type = 'square';
      if (id === 0) { waka = !waka; f0 = f1 = waka ? 540 : 400; duree = 0.07; }
      else if (id === 1) { f0 = 180; f1 = 900; duree = 0.4; type = 'sawtooth'; }
      else if (id === 2) { f0 = 300; f1 = 1000; duree = 0.25; }
      else if (id === 3) { f0 = 700; f1 = 60; duree = 0.9; type = 'sawtooth'; }
      else if (id === 4) { f0 = 400; f1 = 1400; duree = 0.6; type = 'triangle'; }
      o.type = type;
      o.frequency.setValueAtTime(f0, t);
      o.frequency.exponentialRampToValueAtTime(Math.max(f1, 1), t + duree);
      g.gain.setValueAtTime(0.08, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + duree);
      o.start(t); o.stop(t + duree + 0.05);
    } catch (e) { /* audio indisponible : on ignore */ }
  }

  /* --- dessin --- */
  const ANG_PAC = [0, Math.PI, -Math.PI / 2, Math.PI / 2]; // droite, gauche, haut, bas

  function dessinerPac(x, y, dir, bouche) {
    const a = ANG_PAC[dir] || 0;
    const ouvert = [0.02, 0.22, 0.42, 0.22][bouche & 3] * Math.PI;
    ctx.fillStyle = '#ffe600';
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.arc(x, y, 8, a + ouvert, a - ouvert + Math.PI * 2);
    ctx.closePath();
    ctx.fill();
  }

  const COULEURS_FANTOMES = ['#ff2222', '#ffb8de', '#00e8e8', '#ffb847'];

  function dessinerFantome(x, y, couleur, mode) {
    // mode : 0 poursuite, 1 dispersion, 2 peur, 3 peur clignotante, 4 yeux seuls
    const corps = mode === 2 ? '#2430ff'
      : mode === 3 ? (((tick >> 4) & 1) ? '#2430ff' : '#f8f8f8')
      : COULEURS_FANTOMES[couleur] || '#fff';
    if (mode !== 4) {
      ctx.fillStyle = corps;
      ctx.beginPath();
      ctx.moveTo(x - 8, y + 7);
      ctx.lineTo(x - 8, y - 2);
      ctx.arc(x, y - 2, 8, Math.PI, 0);
      ctx.lineTo(x + 8, y + 7);
      for (let i = 0; i < 4; i++) {
        ctx.lineTo(x + 6 - 4 * i, y + 4);
        ctx.lineTo(x + 4 - 4 * i, y + 7);
      }
      ctx.closePath();
      ctx.fill();
    }
    if (mode === 2 || mode === 3) {
      // visage effraye : petits yeux + bouche en zigzag
      ctx.fillStyle = '#ffd8c8';
      ctx.beginPath();
      ctx.arc(x - 3, y - 3, 2, 0, Math.PI * 2);
      ctx.arc(x + 3, y - 3, 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#ffd8c8';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x - 5, y + 4);
      for (let i = 0; i < 5; i++) {
        ctx.lineTo(x - 5 + 2 * i + 1, y + 2.5);
        ctx.lineTo(x - 5 + 2 * i + 2, y + 4);
      }
      ctx.stroke();
    } else {
      // yeux blancs + pupilles bleues
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.ellipse(x - 3, y - 3, 2.6, 3.6, 0, 0, Math.PI * 2);
      ctx.ellipse(x + 3, y - 3, 2.6, 3.6, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#2030ff';
      ctx.beginPath();
      ctx.arc(x - 3, y - 3, 1.6, 0, Math.PI * 2);
      ctx.arc(x + 3, y - 3, 1.6, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function construireMurs(octets) {
    const off = document.createElement('canvas');
    off.width = W; off.height = H;
    const c = off.getContext('2d');
    c.fillStyle = '#000';
    c.fillRect(0, 0, W, H);
    const a = (x, y) =>
      (x < 0 || x >= COLS || y < 0 || y >= ROWS) ? '#' : String.fromCharCode(octets[y * COLS + x]);
    for (let y = 0; y < ROWS; y++) {
      for (let x = 0; x < COLS; x++) {
        const t = a(x, y);
        const px = x * TILE, py = y * TILE;
        if (t === '#') {
          c.fillStyle = '#0d0d8f';
          c.fillRect(px, py, TILE, TILE);
          c.strokeStyle = '#4d6bff';
          c.lineWidth = 2;
          c.strokeRect(px + 1.5, py + 1.5, TILE - 3, TILE - 3);
        } else if (t === '-') {
          c.strokeStyle = '#ffb8ae';
          c.lineWidth = 3;
          c.beginPath();
          c.moveTo(px, py + 8);
          c.lineTo(px + TILE, py + 8);
          c.stroke();
        }
      }
    }
    return off;
  }

  /* --- fonctions importees par le wasm --- */
  const env = {
    js_clear() {
      if (murs) ctx.drawImage(murs, 0, 0);
      else { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H); }
    },
    js_pellet(x, y) {
      ctx.fillStyle = '#ffb8ae';
      ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fill();
    },
    js_power(x, y) {
      const r = Math.max(5 + 2 * Math.sin(tick / 5), 3);
      ctx.fillStyle = '#ffb8ae';
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    },
    js_pac(x, y, dir, bouche) { dessinerPac(x, y, dir, bouche); },
    js_ghost(x, y, couleur, mode) { dessinerFantome(x, y, couleur, mode); },
    js_sfx(id) { sfx(id); },
  };

  /* --- HUD + messages --- */
  function texte(t, x, y, taille, couleur) {
    ctx.font = 'bold ' + taille + 'px monospace';
    ctx.fillStyle = couleur;
    ctx.textAlign = 'center';
    ctx.fillText(t, x, y);
  }

  function hud() {
    if (!ex) return;
    scoreEl.textContent = ex.get_score();
    niveauEl.textContent = ex.get_level();
    const v = Math.max(ex.get_lives(), 0);
    viesEl.textContent = v > 0 ? '\u{1F7E1}'.repeat(v) : '—';
    const s = ex.get_state();
    if (s === 0) texte('PRÊT !', W / 2, H / 2 + 8, 24, '#ffe600');
    else if (s === 3) {
      texte('GAME OVER', W / 2, H / 2, 28, '#ff4040');
      texte('Entrée pour rejouer', W / 2, H / 2 + 32, 14, '#ffffff');
    } else if (s === 4) texte('BRAVO !', W / 2, H / 2 + 8, 28, '#ffe600');
  }

  /* --- clavier : 0 droite, 1 gauche, 2 haut, 3 bas (comme dans le wasm) --- */
  const TOUCHES = {
    ArrowRight: 0, ArrowLeft: 1, ArrowUp: 2, ArrowDown: 3,
    d: 0, D: 0, q: 1, Q: 1, a: 1, A: 1, z: 2, Z: 2, s: 3, S: 3,
  };
  window.addEventListener('keydown', (e) => {
    if (!ex) return;
    if (TOUCHES[e.key] !== undefined) { ex.set_dir(TOUCHES[e.key]); e.preventDefault(); }
    else if (e.key === 'Enter' || e.key === ' ') { ex.start(); e.preventDefault(); }
  });

  /* --- demarrage --- */
  async function main() {
    const resp = await fetch('pacman.wasm');
    if (!resp.ok) {
      throw new Error(
        'pacman.wasm introuvable. Lance un serveur HTTP dans ce dossier, ' +
        'ex: python3 -m http.server 8000, puis ouvre http://localhost:8000');
    }
    const tampon = await resp.arrayBuffer();
    const { instance } = await WebAssembly.instantiate(tampon, { env });
    ex = instance.exports;
    ex.init_game();
    const mem = new Uint8Array(ex.memory.buffer);
    const ptr = ex.get_maze();
    murs = construireMurs(mem.slice(ptr, ptr + COLS * ROWS));

    let dernier = performance.now();
    let acc = 0;
    const PAS = 1000 / 60;
    function boucle(now) {
      requestAnimationFrame(boucle);
      acc += Math.min(now - dernier, 100);
      dernier = now;
      while (acc >= PAS) { ex.tick(); tick++; acc -= PAS; }
      hud();
    }
    requestAnimationFrame(boucle);
  }

  main().catch((e) => { erreurEl.textContent = 'Erreur : ' + e.message; });
})();
