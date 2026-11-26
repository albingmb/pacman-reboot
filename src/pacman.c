/*
 * Pac-Man 3D — clone en WebAssembly pur.
 *
 * Difference majeure avec la version 2D : le labyrinthe est un CUBE
 * (S x S x S cases) genere proceduralement a chaque niveau, Pac-Man se
 * deplace en 6 directions (+X,+Y,-X,-Y,+Z,-Z) et la vue est subjective
 * (POV) : le JavaScript fait le rendu 3D par raycasting a partir de la
 * position du joueur lue dans la memoire du wasm.
 *
 * Toute la logique (generation du labyrinthe, deplacements, IA des
 * fantomes, score, vies, niveaux) tourne ici, compile en wasm32.
 *
 * Compilation (voir build.sh) :
 *   zig cc -target wasm32-freestanding -O2 -nostdlib -Wl,--no-entry \
 *          -Wl,--export-memory -Wl,--initial-memory=1048576 -o pacman.wasm pacman.c
 */

#define S 15                 /* le labyrinthe est un cube S x S x S */
#define TILE 16              /* taille d'une case en "pixels" monde */
#define NCELL (S * S * S)
#define CELL(x, y, z) laby[((z) * S + (y)) * S + (x)]

/* 6 directions 3D : 0:+X 1:+Y 2:-X 3:-Y 4:+Z (haut) 5:-Z (bas) */
static const int DX3[6] = { 1, 0, -1, 0, 0, 0 };
static const int DY3[6] = { 0, 1, 0, -1, 0, 0 };
static const int DZ3[6] = { 0, 0, 0, 0, 1, -1 };
static const int OPP3[6] = { 2, 3, 0, 1, 5, 4 };

/* --- fonctions fournies par le JavaScript --- */
__attribute__((import_module("env"), import_name("js_clear")))
extern void js_clear(void);
__attribute__((import_module("env"), import_name("js_ghost")))
extern void js_ghost(int x, int y, int z, int couleur, int mode);
__attribute__((import_module("env"), import_name("js_sfx")))
extern void js_sfx(int id);

/* --- etats du jeu --- */
enum { S_PRET, S_JEU, S_MORT, S_OVER, S_NIVEAU };

typedef struct { int px, py, pz, dir, acc; } Ent;

typedef struct {
    Ent e;
    int couleur;          /* 0 Blinky, 1 Pinky, 2 Inky, 3 Clyde */
    int yeux;             /* 1 = fantome mange, retourne a son spawn */
    int sx, sy, sz;       /* case de spawn (yeux y retournent) */
    int coin[3];          /* coin de dispersion */
} Fantome;

static char laby[NCELL];

static Ent pac;
static int pac_voulue;    /* direction voulue : 0..5, ou -1 = aucune */
static Fantome fantomes[4];

static int score, vies, niveau, gommes;
static int etat, etat_timer;
static int peur, combo;
static int mode_idx, mode_timer, inverse;
static unsigned tick_count;
static unsigned rng, gen_count;

/* alternance dispersion / poursuite (en ticks a 60 Hz) */
static const int HORAIRE[8] = { 420, 1200, 420, 1200, 300, 1200, 300, 1 << 30 };

static unsigned nextrand(void) {
    rng ^= rng << 13;
    rng ^= rng >> 17;
    rng ^= rng << 5;
    return rng;
}

/* --- generation du labyrinthe cubique (backtracker iteratif) --- */
static void generer_laby(void) {
    static const int DD[6][3] = {
        { 2, 0, 0 }, { -2, 0, 0 }, { 0, 2, 0 }, { 0, -2, 0 }, { 0, 0, 2 }, { 0, 0, -2 }
    };
    static int stk[NCELL];
    int i, top = 0, k;
    for (i = 0; i < NCELL; i++) laby[i] = '#';
    rng = 0x2545F491u ^ (gen_count++ * 2654435761u) ^ ((unsigned)niveau * 40503u);
    if (rng == 0) rng = 1;

    /* carve depuis (1,1,1) sur la grille des cases impaires */
    CELL(1, 1, 1) = ' ';
    stk[top++] = (1 * S + 1) * S + 1;
    while (top > 0) {
        int cur = stk[top - 1];
        int x = cur % S, y = (cur / S) % S, z = cur / (S * S);
        int opts[6], n = 0;
        for (k = 0; k < 6; k++) {
            int nx = x + DD[k][0], ny = y + DD[k][1], nz = z + DD[k][2];
            if (nx < 1 || ny < 1 || nz < 1 || nx > S - 2 || ny > S - 2 || nz > S - 2)
                continue;
            if (CELL(nx, ny, nz) == '#') opts[n++] = k;
        }
        if (n == 0) { top--; continue; }
        k = opts[nextrand() % n];
        CELL(x + DD[k][0] / 2, y + DD[k][1] / 2, z + DD[k][2] / 2) = ' ';
        CELL(x + DD[k][0], y + DD[k][1], z + DD[k][2]) = ' ';
        stk[top++] = ((z + DD[k][2]) * S + (y + DD[k][1])) * S + (x + DD[k][0]);
    }

    /* casser quelques murs internes pour creer des boucles */
    for (i = 0; i < 80; i++) {
        int x = 1 + (int)(nextrand() % (S - 2));
        int y = 1 + (int)(nextrand() % (S - 2));
        int z = 1 + (int)(nextrand() % (S - 2));
        int nx, ny, nz;
        k = (int)(nextrand() % 6);
        nx = x + DD[k][0]; ny = y + DD[k][1]; nz = z + DD[k][2];
        if (nx < 0 || ny < 0 || nz < 0 || nx >= S || ny >= S || nz >= S) continue;
        if (CELL(x, y, z) == '#' && CELL(nx, ny, nz) != '#') CELL(x, y, z) = ' ';
    }

    /* cases de spawn sans gomme */
    CELL(1, 1, 1) = ' ';
    CELL(S - 2, S - 2, S - 2) = ' ';
    CELL(1, S - 2, 1) = ' ';
    CELL(S - 2, 1, 1) = ' ';
    CELL(1, 1, S - 2) = ' ';

    /* 4 super-gommes, dont une au centre du cube */
    CELL(S - 2, S - 2, 1) = 'o';
    CELL(S - 2, 1, S - 2) = 'o';
    CELL(1, S - 2, S - 2) = 'o';
    CELL(S / 2, S / 2, S / 2) = 'o';

    /* gomme dans toutes les cases ouvertes restantes */
    gommes = 0;
    for (i = 0; i < NCELL; i++)
        if (laby[i] == ' ') { laby[i] = '.'; gommes++; }
    gommes += 4; /* les super-gommes comptent aussi */
}

static int dans_cube(int x, int y, int z) {
    return x >= 0 && x < S && y >= 0 && y < S && z >= 0 && z < S;
}

static int peut_pac(int x, int y, int z) {
    return dans_cube(x, y, z) && CELL(x, y, z) != '#';
}

static void reset_positions(void) {
    int i;
    pac.px = 1 * TILE + 8; pac.py = 1 * TILE + 8; pac.pz = 1 * TILE + 8;
    pac.dir = 0; pac.acc = 0; pac_voulue = -1;
    for (i = 0; i < 4; i++) {
        fantomes[i].e.acc = 0;
        fantomes[i].e.dir = 0;
        fantomes[i].yeux = 0;
        fantomes[i].couleur = i;
    }
    fantomes[0].e.px = (S - 2) * TILE + 8; fantomes[0].e.py = (S - 2) * TILE + 8; fantomes[0].e.pz = (S - 2) * TILE + 8;
    fantomes[1].e.px = 1 * TILE + 8;          fantomes[1].e.py = (S - 2) * TILE + 8; fantomes[1].e.pz = 1 * TILE + 8;
    fantomes[2].e.px = (S - 2) * TILE + 8;     fantomes[2].e.py = 1 * TILE + 8;          fantomes[2].e.pz = 1 * TILE + 8;
    fantomes[3].e.px = 1 * TILE + 8;           fantomes[3].e.py = 1 * TILE + 8;          fantomes[3].e.pz = (S - 2) * TILE + 8;
    for (i = 0; i < 4; i++) {
        fantomes[i].sx = fantomes[i].e.px / TILE;
        fantomes[i].sy = fantomes[i].e.py / TILE;
        fantomes[i].sz = fantomes[i].e.pz / TILE;
    }
    fantomes[0].coin[0] = S - 2; fantomes[0].coin[1] = S - 2; fantomes[0].coin[2] = 1;
    fantomes[1].coin[0] = 1;     fantomes[1].coin[1] = S - 2; fantomes[1].coin[2] = S - 2;
    fantomes[2].coin[0] = S - 2; fantomes[2].coin[1] = 1;     fantomes[2].coin[2] = S - 2;
    fantomes[3].coin[0] = 1;     fantomes[3].coin[1] = 1;     fantomes[3].coin[2] = 1;
    peur = 0; combo = 0;
    mode_idx = 0; mode_timer = HORAIRE[0]; inverse = 0;
}

/* cible d'un fantome selon sa personnalite (version 3D) */
static void fantome_cible(int i, int *cx, int *cy, int *cz) {
    Fantome *f = &fantomes[i];
    int px = pac.px / TILE, py = pac.py / TILE, pz = pac.pz / TILE;
    if (f->yeux) { *cx = f->sx; *cy = f->sy; *cz = f->sz; return; }
    if ((mode_idx & 1) == 0) { *cx = f->coin[0]; *cy = f->coin[1]; *cz = f->coin[2]; return; }
    switch (i) {
    case 0: /* Blinky : poursuit Pac-Man */
        *cx = px; *cy = py; *cz = pz;
        break;
    case 1: /* Pinky : vise 4 cases devant Pac-Man */
        *cx = px + DX3[pac.dir] * 4;
        *cy = py + DY3[pac.dir] * 4;
        *cz = pz + DZ3[pac.dir] * 4;
        break;
    case 2: { /* Inky : symetrique de Pac-Man par rapport a Blinky */
        int bx = fantomes[0].e.px / TILE, by = fantomes[0].e.py / TILE, bz = fantomes[0].e.pz / TILE;
        *cx = 2 * (px + DX3[pac.dir] * 2) - bx;
        *cy = 2 * (py + DY3[pac.dir] * 2) - by;
        *cz = 2 * (pz + DZ3[pac.dir] * 2) - bz;
        break;
    }
    default: { /* Clyde : poursuit si loin, sinon retourne dans son coin */
        int dx = px - f->e.px / TILE, dy = py - f->e.py / TILE, dz = pz - f->e.pz / TILE;
        if (dx * dx + dy * dy + dz * dz > 64) { *cx = px; *cy = py; *cz = pz; }
        else { *cx = f->coin[0]; *cy = f->coin[1]; *cz = f->coin[2]; }
        break;
    }
    }
}

/* choisit la direction d'un fantome au centre d'une case (6 directions) */
static void fantome_decider(Fantome *f, int i, int tx, int ty, int tz) {
    int k, d, eff;
    if (inverse && !f->yeux) f->e.dir = OPP3[f->e.dir];
    eff = f->yeux ? 4 : (peur > 0 ? 2 : ((mode_idx & 1) ? 0 : 1));
    if (eff == 2) { /* peur : direction aleatoire parmi les 6 */
        int opts[6], n = 0;
        for (k = 0; k < 6; k++) {
            d = k;
            if (d == OPP3[f->e.dir]) continue;
            if (peut_pac(tx + DX3[d], ty + DY3[d], tz + DZ3[d])) opts[n++] = d;
        }
        if (n == 0) f->e.dir = OPP3[f->e.dir];
        else f->e.dir = opts[(tick_count >> 3) % n];
        return;
    }
    {
        int cx, cy, cz, best = -1, bestd = 1 << 30;
        fantome_cible(i, &cx, &cy, &cz);
        for (k = 0; k < 6; k++) {
            int ddx, ddy, ddz, dist;
            d = k;
            if (d == OPP3[f->e.dir]) continue;
            if (!peut_pac(tx + DX3[d], ty + DY3[d], tz + DZ3[d])) continue;
            ddx = tx + DX3[d] - cx;
            ddy = ty + DY3[d] - cy;
            ddz = tz + DZ3[d] - cz;
            dist = ddx * ddx + ddy * ddy + ddz * ddz;
            if (dist < bestd) { bestd = dist; best = d; }
        }
        f->e.dir = (best < 0) ? OPP3[f->e.dir] : best;
    }
}

/* avance une entite, pixel par pixel ; la decision se fait au centre de
   la case AVANT de bouger (une entite arretee face a un mur n'y rentre pas) */
static void avancer(Ent *e, int vit, int est_pac, Fantome *f, int i) {
    e->acc += vit;
    while (e->acc >= 8) {
        e->acc -= 8;
        if (e->px % TILE == 8 && e->py % TILE == 8 && e->pz % TILE == 8) {
            int tx = e->px / TILE, ty = e->py / TILE, tz = e->pz / TILE;
            if (est_pac) {
                char c = CELL(tx, ty, tz);
                if (c == '.') {
                    CELL(tx, ty, tz) = ' '; gommes--; score += 10; js_sfx(0);
                } else if (c == 'o') {
                    CELL(tx, ty, tz) = ' '; gommes--; score += 50;
                    peur = 420 - niveau * 40;
                    if (peur < 90) peur = 90;
                    combo = 0; inverse = 1; js_sfx(1);
                }
                if (pac_voulue >= 0 &&
                    peut_pac(tx + DX3[pac_voulue], ty + DY3[pac_voulue], tz + DZ3[pac_voulue]))
                    e->dir = pac_voulue;
                if (!peut_pac(tx + DX3[e->dir], ty + DY3[e->dir], tz + DZ3[e->dir]))
                    return; /* mur : on reste au centre */
            } else {
                fantome_decider(f, i, tx, ty, tz);
            }
        }
        e->px += DX3[e->dir];
        e->py += DY3[e->dir];
        e->pz += DZ3[e->dir];
        if (e->px < 8) e->px = 8;
        if (e->py < 8) e->py = 8;
        if (e->pz < 8) e->pz = 8;
        if (e->px > S * TILE - 8) e->px = S * TILE - 8;
        if (e->py > S * TILE - 8) e->py = S * TILE - 8;
        if (e->pz > S * TILE - 8) e->pz = S * TILE - 8;
    }
}

/* ---------------- API exportee vers le JavaScript ---------------- */

__attribute__((export_name("init_game")))
void init_game(void) {
    score = 0; vies = 3; niveau = 1; tick_count = 0; gen_count = 0;
    generer_laby();
    reset_positions();
    etat = S_PRET;
    etat_timer = 120;
}

__attribute__((export_name("start")))
void start(void) {
    if (etat == S_OVER) init_game();
    else if (etat == S_PRET) etat_timer = 1;
}

__attribute__((export_name("set_move")))
void set_move(int m) {
    if (m >= -1 && m < 6) pac_voulue = m;
}

__attribute__((export_name("tick")))
void tick(void) {
    int i;
    tick_count++;
    inverse = 0;
    switch (etat) {
    case S_PRET:
        if (--etat_timer <= 0) etat = S_JEU;
        break;
    case S_JEU: {
        int v_pac = 16 + (niveau - 1); if (v_pac > 20) v_pac = 20;
        int v_fan = 15 + (niveau - 1) / 2; if (v_fan > 18) v_fan = 18;
        if (peur > 0) peur--;
        if (--mode_timer <= 0) {
            if (mode_idx < 7) mode_idx++;
            mode_timer = (mode_idx < 7) ? HORAIRE[mode_idx] : (1 << 30);
            inverse = 1;
        }
        avancer(&pac, v_pac, 1, 0, 0);
        for (i = 0; i < 4; i++) {
            Fantome *f = &fantomes[i];
            int v = f->yeux ? 26 : (peur > 0 ? 10 : v_fan);
            avancer(&f->e, v, 0, f, i);
            if (f->yeux && f->e.px / TILE == f->sx && f->e.py / TILE == f->sy && f->e.pz / TILE == f->sz)
                f->yeux = 0; /* les yeux sont rentres : le fantome revit */
        }
        for (i = 0; i < 4; i++) {
            Fantome *f = &fantomes[i];
            int dx = f->e.px - pac.px, dy = f->e.py - pac.py, dz = f->e.pz - pac.pz;
            if (dx * dx + dy * dy + dz * dz < 144) {
                if (f->yeux) continue;
                if (peur > 0) {
                    score += 200 << combo;
                    if (combo < 3) combo++;
                    f->yeux = 1;
                    js_sfx(2);
                } else {
                    etat = S_MORT;
                    etat_timer = 100;
                    js_sfx(3);
                }
            }
        }
        if (etat == S_JEU && gommes <= 0) {
            etat = S_NIVEAU;
            etat_timer = 150;
            js_sfx(4);
        }
        break;
    }
    case S_MORT:
        if (--etat_timer <= 0) {
            vies--;
            if (vies <= 0) etat = S_OVER;
            else { reset_positions(); etat = S_PRET; etat_timer = 120; }
        }
        break;
    case S_NIVEAU:
        if (--etat_timer <= 0) {
            niveau++;
            generer_laby();   /* nouveau cube, nouvelle graine */
            reset_positions();
            etat = S_PRET;
            etat_timer = 120;
        }
        break;
    case S_OVER:
        break;
    }

    /* le JS fait tout le rendu 3D : on lui signale juste les fantomes */
    js_clear();
    for (i = 0; i < 4; i++) {
        Fantome *f = &fantomes[i];
        int m;
        if (f->yeux) m = 4;
        else if (peur > 0) m = (peur < 120 && ((tick_count >> 4) & 1)) ? 3 : 2;
        else m = (mode_idx & 1) ? 0 : 1;
        js_ghost(f->e.px, f->e.py, f->e.pz, f->couleur, m);
    }
}

__attribute__((export_name("get_score")))
int get_score(void) { return score; }

__attribute__((export_name("get_lives")))
int get_lives(void) { return vies; }

__attribute__((export_name("get_level")))
int get_level(void) { return niveau; }

__attribute__((export_name("get_state")))
int get_state(void) { return etat; }

__attribute__((export_name("get_tick")))
unsigned get_tick(void) { return tick_count; }

__attribute__((export_name("get_px")))
int get_px(void) { return pac.px; }

__attribute__((export_name("get_py")))
int get_py(void) { return pac.py; }

__attribute__((export_name("get_pz")))
int get_pz(void) { return pac.pz; }

__attribute__((export_name("get_size")))
int get_size(void) { return S; }

__attribute__((export_name("get_maze")))
const char *get_maze(void) { return &laby[0]; }
