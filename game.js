/*
 * Pac-Man 3D — rendu subjectif style "Dungeon Master".
 * Le wasm contient toute la logique (cube 15x15x15, deplacements 6D, IA) ;
 * ce fichier lit la position du joueur et le labyrinthe dans la memoire du
 * wasm et projette la scene en 3D sur le canvas :
 *   - murs en briques texturees (raycasting DDA, ombrage a la distance)
 *   - sol en damier projette (floor-casting) + plafond en dégradé
 *   - gommes / fantomes en sprites billboards avec occlusion
 *   - mini-carte de l'etage courant (position + orientation)
 *   - vignette + viseur
 */
'use strict';
(() => {
  const TILE = 16;
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const FOV = Math.PI / 3;                 // 60 degres
  const focal = (W / 2) / Math.tan(FOV / 2);
  const scoreEl = document.getElementById('score');
  const niveauEl = document.getElementById('niveau');
  const viesEl = document.getElementById('vies');
  const etageEl = document.getElementById('etage');
  const posEl = document.getElementById('pos');
  const erreurEl = document.getElementById('erreur');

  let ex = null, S = 0, mazePtr = 0;
  let yaw = 0;              // cap sur la grille : 0:+X 1:+Y 2:-X 3:-Y
  let viewAngle = 0;        // angle lisse pour le rendu
  let pitchPx = 0;          // decalage de l'horizon (regarder haut/bas)
  let tick = 0;
  const keys = new Set();
  let ghostList = [];
  let waka = false;
  let ac = null;
  let wallShades = null;    // textures de mur pre-ombrees
  let vignette = null;

  /* move intents wasm : 0:+X 1:+Y 2:-X 3:-Y 4:+Z 5:-Z */
  const OPP = [2, 3, 0, 1];

  /* --- sons --- */
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
    } catch (e) { /* audio indisponible */ }
  }

  /* --- fonctions importees par le wasm --- */
  const env = {
    js_clear() { ghostList = []; },
    js_ghost(x, y, z, couleur, mode) { ghostList.push({ x, y, z, couleur, mode }); },
    js_sfx(id) { sfx(id); },
  };

  /* --- textures pre-rendues --- */
  function makeWallTexture() {
    const t = document.createElement('canvas');
    t.width = 64; t.height = 64;
    const c = t.getContext('2d');
    c.fillStyle = '#0a0a28';                       // mortier
    c.fillRect(0, 0, 64, 64);
    for (let row = 0; row < 4; row++) {            // briques 32x16 decalees
      const y = row * 16;
      const off = (row % 2) * 16;
      for (let bx = -1; bx < 3; bx++) {
        const x = bx * 32 + off;
        const v = (bx * 37 + row * 61) % 40;
        c.fillStyle = 'rgb(' + (45 + v) + ',' + (70 + v) + ',' + (190 + (v >> 1)) + ')';
        c.fillRect(x + 2, y + 2, 28, 12);
        c.fillStyle = 'rgba(255,255,255,0.10)';    // reflet haut de brique
        c.fillRect(x + 2, y + 2, 28, 3);
      }
    }
    /* rainures verticales : chaque case a son propre "panneau" (style DM) */
    c.fillStyle = 'rgba(0,0,15,0.95)';
    c.fillRect(0, 0, 3, 64);
    c.fillRect(61, 0, 3, 64);
    return t;
  }

  function makeShades(tex) {
    const out = [];
    for (let i = 0; i < 8; i++) {
      const t = document.createElement('canvas');
      t.width = 64; t.height = 64;
      const c = t.getContext('2d');
      c.drawImage(tex, 0, 0);
      c.fillStyle = 'rgba(0,0,10,' + (i / 7 * 0.78).toFixed(3) + ')';
      c.fillRect(0, 0, 64, 64);
      out.push(t);
    }
    return out;
  }

  function makeVignette() {
    const v = document.createElement('canvas');
    v.width = W; v.height = H;
    const c = v.getContext('2d');
    const g = c.createRadialGradient(W / 2, H / 2, H * 0.35, W / 2, H / 2, H * 0.78);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(0,0,0,0.5)');
    c.fillStyle = g;
    c.fillRect(0, 0, W, H);
    return v;
  }

  /* --- projection 3D -> ecran --- */
  function project(wx, wy, wz, px, py, pz, horizon) {
    const dx = wx - px, dy = wy - py, dz = wz - pz;
    const ca = Math.cos(viewAngle), sa = Math.sin(viewAngle);
    const vx = dx * ca + dy * sa;       // profondeur devant le joueur
    const vy = -dx * sa + dy * ca;      // decalage lateral
    if (vx < 2) return null;
    return {
      sx: W / 2 + (vy / vx) * focal,
      sy: horizon - (dz / vx) * focal,
      vx,
      h: (TILE / vx) * focal,
    };
  }

  function drawGhostSprite(p, couleur, mode) {
    const h = p.h * 0.9, w = h * 0.9;
    const sx = p.sx, sy = p.sy;
    let corps = ['#ff2222', '#ffb8de', '#00e8e8', '#ffb847'][couleur] || '#fff';
    if (mode === 2) corps = '#2430ff';
    else if (mode === 3) corps = ((tick >> 4) & 1) ? '#2430ff' : '#f8f8f8';
    ctx.globalAlpha = Math.max(0.15, 1 - p.vx / 220);
    if (mode !== 4) {
      ctx.fillStyle = corps;
      ctx.beginPath();
      ctx.moveTo(sx - w / 2, sy + h / 2);
      ctx.lineTo(sx - w / 2, sy - h * 0.1);
      ctx.arc(sx, sy - h * 0.1, w / 2, Math.PI, 0);
      ctx.lineTo(sx + w / 2, sy + h / 2);
      const n = 4;
      for (let i = 0; i < n; i++) {
        ctx.lineTo(sx + w / 2 - (i + 0.5) * (w / n), sy + h / 2 - h * 0.12);
        ctx.lineTo(sx + w / 2 - (i + 1) * (w / n), sy + h / 2);
      }
      ctx.closePath();
      ctx.fill();
    }
    ctx.fillStyle = (mode === 2 || mode === 3) ? '#ffd8c8' : '#fff';
    ctx.beginPath();
    ctx.arc(sx - w * 0.18, sy, w * 0.11, 0, Math.PI * 2);
    ctx.arc(sx + w * 0.18, sy, w * 0.11, 0, Math.PI * 2);
    ctx.fill();
    if (mode < 2) {
      ctx.fillStyle = '#2030ff';
      ctx.beginPath();
      ctx.arc(sx - w * 0.18, sy, w * 0.055, 0, Math.PI * 2);
      ctx.arc(sx + w * 0.18, sy, w * 0.055, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  /* --- mini-carte de l'etage courant --- */
  function drawMinimap(maze, px, py, pz) {
    const ms = 9;
    const mw = S * ms;
    const ox = W - mw - 12, oy = 12;
    const cellZ = Math.min(S - 1, Math.max(0, Math.floor(pz / TILE)));
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = '#000010';
    ctx.fillRect(ox - 4, oy - 4, mw + 8, mw + 8);
    for (let y = 0; y < S; y++)
      for (let x = 0; x < S; x++) {
        const c = maze[(cellZ * S + y) * S + x];
        if (c === 35) {
          ctx.fillStyle = '#2b3dff';
          ctx.fillRect(ox + x * ms, oy + y * ms, ms, ms);
        } else {
          ctx.fillStyle = '#0a0a18';
          ctx.fillRect(ox + x * ms, oy + y * ms, ms, ms);
          if (c === 46) {
            ctx.fillStyle = '#ffb8ae';
            ctx.fillRect(ox + x * ms + ms / 2 - 1, oy + y * ms + ms / 2 - 1, 2, 2);
          } else if (c === 111) {
            ctx.fillStyle = '#ffb8ae';
            ctx.fillRect(ox + x * ms + ms / 2 - 2, oy + y * ms + ms / 2 - 2, 4, 4);
          }
        }
      }
    for (const g of ghostList) {
      if (Math.floor(g.z / TILE) !== cellZ) continue;
      ctx.fillStyle = (g.mode === 2 || g.mode === 3)
        ? '#2430ff'
        : ['#ff2222', '#ffb8de', '#00e8e8', '#ffb847'][g.couleur];
      ctx.fillRect(ox + (g.x / TILE) * ms - 3, oy + (g.y / TILE) * ms - 3, 6, 6);
    }
    /* fleche du joueur orientee selon le cap */
    ctx.fillStyle = '#ffe600';
    ctx.save();
    ctx.translate(ox + (px / TILE) * ms, oy + (py / TILE) * ms);
    ctx.rotate(yaw * Math.PI / 2);
    ctx.beginPath();
    ctx.moveTo(6, 0); ctx.lineTo(-4, -4); ctx.lineTo(-4, 4);
    ctx.closePath(); ctx.fill();
    ctx.restore();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = 'rgba(120,140,255,0.6)';
    ctx.strokeRect(ox - 4, oy - 4, mw + 8, mw + 8);
  }

  /* --- rendu principal (style Dungeon Master) --- */
  function render() {
    const px = ex.get_px(), py = ex.get_py(), pz = ex.get_pz();
    const maze = new Uint8Array(ex.memory.buffer, mazePtr, S * S * S);
    const cellZ = Math.min(S - 1, Math.max(0, Math.floor(pz / TILE)));

    /* lissage de l'angle de vue vers le cap de la grille */
    const target = yaw * Math.PI / 2;
    let d = target - viewAngle;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    viewAngle += d * 0.3;

    const horizon = H / 2 + pitchPx;

    /* plafond en degrade */
    const gUp = ctx.createLinearGradient(0, 0, 0, Math.max(horizon, 1));
    gUp.addColorStop(0, '#020208');
    gUp.addColorStop(1, '#0d0d24');
    ctx.fillStyle = gUp;
    ctx.fillRect(0, 0, W, Math.max(horizon, 0));

    /* sol en damier par floor-casting */
    const y0 = Math.max(0, Math.ceil(horizon));
    if (y0 < H) {
      const rows = H - y0;
      const img = ctx.createImageData(W, rows);
      const data = img.data;
      const dirX = Math.cos(viewAngle), dirY = Math.sin(viewAngle);
      const t = Math.tan(FOV / 2);
      const plX = -dirY * t, plY = dirX * t;
      const rX0 = dirX - plX, rY0 = dirY - plY;
      const rX1 = dirX + plX, rY1 = dirY + plY;
      for (let y = 0; y < rows; y++) {
        const p = (y + y0) - horizon + 0.5;
        if (p <= 0.01) continue;
        const D = (0.5 * TILE * focal) / p;   // distance reelle au sol
        const shade = Math.max(0.12, Math.min(1, 1.25 - D / 240));
        for (let x = 0; x < W; x++) {
          const w = x / W;
          const fx = px + D * (rX0 + (rX1 - rX0) * w);
          const fy = py + D * (rY0 + (rY1 - rY0) * w);
          const cx = Math.floor(fx / TILE), cy = Math.floor(fy / TILE);
          const wall = cx < 0 || cy < 0 || cx >= S || cy >= S ||
            maze[(cellZ * S + cy) * S + cx] === 35;
          let r, g, b;
          if (wall) { r = 20; g = 24; b = 60; }
          else if ((cx + cy) & 1) { r = 46; g = 50; b = 84; }
          else { r = 22; g = 24; b = 44; }
          const o = (y * W + x) * 4;
          data[o] = r * shade; data[o + 1] = g * shade; data[o + 2] = b * shade; data[o + 3] = 255;
        }
      }
      ctx.putImageData(img, 0, y0);
    }

    /* murs en briques texturees : un rayon par colonne (DDA) */
    ctx.imageSmoothingEnabled = false;
    const wallDist = new Float32Array(W);
    for (let col = 0; col < W; col++) {
      const ang = viewAngle + (col / W - 0.5) * FOV;
      const dx = Math.cos(ang), dy = Math.sin(ang);
      let mapX = Math.floor(px / TILE), mapY = Math.floor(py / TILE);
      const dDX = Math.abs(1 / (dx || 1e-9));
      const dDY = Math.abs(1 / (dy || 1e-9));
      let stepX, stepY, sideX, sideY;
      if (dx < 0) { stepX = -1; sideX = (px - mapX * TILE) * dDX; }
      else { stepX = 1; sideX = (mapX * TILE + TILE - px) * dDX; }
      if (dy < 0) { stepY = -1; sideY = (py - mapY * TILE) * dDY; }
      else { stepY = 1; sideY = (mapY * TILE + TILE - py) * dDY; }
      let side = 0, dist = 0;
      for (let i = 0; i < 64; i++) {
        if (sideX < sideY) { sideX += dDX; mapX += stepX; dist = sideX - dDX; side = 0; }
        else { sideY += dDY; mapY += stepY; dist = sideY - dDY; side = 1; }
        if (mapX < 0 || mapY < 0 || mapX >= S || mapY >= S) { dist = 1e9; break; }
        if (maze[(cellZ * S + mapY) * S + mapX] === 35) break; // '#'
      }
      const perp = Math.max(0.05, dist * Math.cos(ang - viewAngle)); // anti-fisheye
      wallDist[col] = perp;
      let wallX = (side === 0) ? py + perp * dy : px + perp * dx;
      wallX -= Math.floor(wallX);
      const texX = Math.min(63, Math.floor(wallX * 64));
      const level = Math.min(7, Math.floor(perp / 24) + (side ? 2 : 0));
      const lineH = (TILE / perp) * focal;
      ctx.drawImage(wallShades[level], texX, 0, 1, 64, col, horizon - lineH / 2, 1, lineH);
    }

    /* sprites : gommes + fantomes, du plus loin au plus pres */
    const sprites = [];
    for (let z = 0; z < S; z++)
      for (let y = 0; y < S; y++)
        for (let x = 0; x < S; x++) {
          const c = maze[(z * S + y) * S + x];
          if (c !== 46 && c !== 111) continue; // '.' ou 'o'
          const p = project(x * TILE + 8, y * TILE + 8, z * TILE + 8, px, py, pz, horizon);
          if (p) sprites.push({ p, kind: c === 111 ? 'o' : '.', dist: p.vx });
        }
    for (const g of ghostList) {
      const p = project(g.x, g.y, g.z, px, py, pz, horizon);
      if (p) sprites.push({ p, kind: 'g', g, dist: p.vx });
    }
    sprites.sort((a, b) => b.dist - a.dist);
    for (const s of sprites) {
      const col = Math.min(W - 1, Math.max(0, Math.floor(s.p.sx)));
      if (s.dist > wallDist[col] + 6) continue; // cache par un mur
      if (s.kind === '.') {
        const r = Math.max(1, s.p.h * 0.06);
        ctx.globalAlpha = Math.max(0.2, 1 - s.dist / 220);
        ctx.fillStyle = '#ffb8ae';
        ctx.beginPath(); ctx.arc(s.p.sx, s.p.sy, r, 0, Math.PI * 2); ctx.fill();
      } else if (s.kind === 'o') {
        const r = Math.max(2, s.p.h * 0.16 * (1 + 0.2 * Math.sin(tick / 5)));
        ctx.globalAlpha = Math.max(0.3, 1 - s.dist / 220);
        ctx.fillStyle = '#ffb8ae';
        ctx.beginPath(); ctx.arc(s.p.sx, s.p.sy, r, 0, Math.PI * 2); ctx.fill();
      } else {
        drawGhostSprite(s.p, s.g.couleur, s.g.mode);
      }
      ctx.globalAlpha = 1;
    }

    /* vignette + mini-carte + viseur */
    ctx.drawImage(vignette, 0, 0);
    drawMinimap(maze, px, py, pz);
    ctx.fillStyle = '#ffe600';
    ctx.fillRect(W / 2 - 1, horizon - 1, 3, 3);
  }

  /* --- HUD --- */
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
    etageEl.textContent = Math.floor(ex.get_pz() / TILE);
    posEl.textContent = Math.floor(ex.get_px() / TILE) + ',' +
      Math.floor(ex.get_py() / TILE) + ',' + Math.floor(ex.get_pz() / TILE);
    const s = ex.get_state();
    if (s === 0) texte('PRÊT !', W / 2, H / 2, 26, '#ffe600');
    else if (s === 3) {
      texte('GAME OVER', W / 2, H / 2 - 10, 30, '#ff4040');
      texte('Entrée pour rejouer', W / 2, H / 2 + 24, 14, '#ffffff');
    } else if (s === 4) texte('BRAVO ! Nouveau cube…', W / 2, H / 2, 22, '#ffe600');
  }

  /* --- clavier --- */
  window.addEventListener('keydown', (e) => {
    if (!ex) return;
    const k = e.key.toLowerCase();
    if (k === 'z' || k === 'arrowup') keys.add('f');
    else if (k === 's' || k === 'arrowdown') keys.add('b');
    else if (k === 'q' || k === 'arrowleft') { yaw = (yaw + 3) % 4; e.preventDefault(); }
    else if (k === 'd' || k === 'arrowright') { yaw = (yaw + 1) % 4; e.preventDefault(); }
    else if (k === 'e') keys.add('u');
    else if (k === 'c') keys.add('d');
    else if (k === 'w') { pitchPx = Math.max(-H / 3, pitchPx - 10); e.preventDefault(); }
    else if (k === 'x') { pitchPx = Math.min(H / 3, pitchPx + 10); e.preventDefault(); }
    else if (e.key === 'Enter' || e.key === ' ') { ex.start(); e.preventDefault(); }
    else return;
    e.preventDefault();
  });
  window.addEventListener('keyup', (e) => {
    const k = e.key.toLowerCase();
    keys.delete(k === 'arrowup' ? 'f' : k === 'arrowdown' ? 'b' : k);
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
    S = ex.get_size();
    mazePtr = ex.get_maze();
    wallShades = makeShades(makeWallTexture());
    vignette = makeVignette();

    let dernier = performance.now();
    let acc = 0;
    const PAS = 1000 / 60;
    function boucle(now) {
      requestAnimationFrame(boucle);
      acc += Math.min(now - dernier, 100);
      dernier = now;
      /* intention de deplacement selon les touches maintenues et le cap */
      let m = -1;
      if (keys.has('f')) m = yaw;
      else if (keys.has('b')) m = OPP[yaw];
      else if (keys.has('u')) m = 4;
      else if (keys.has('d')) m = 5;
      ex.set_move(m);
      while (acc >= PAS) { ex.tick(); tick++; acc -= PAS; }
      render();
      hud();
    }
    requestAnimationFrame(boucle);
  }

  main().catch((e) => { erreurEl.textContent = 'Erreur : ' + e.message; });
})();
