/*
 * Pac-Man — clone en WebAssembly pur.
 *
 * Toute la logique du jeu (labyrinthe, Pac-Man, 4 fantômes, score, vies,
 * niveaux) tourne dans ce fichier compilé en .wasm. Le JavaScript ne fait
 * que dessiner ce que le wasm lui demande (fonctions importees js_*) et
 * lire l'etat du jeu (fonctions exportees get_*).
 *
 * Compilation (voir build.sh) :
 *   zig cc -target wasm32-freestanding -O2 -nostdlib -Wl,--no-entry \
 *          -Wl,--export-memory -Wl,--initial-memory=1048576 -o pacman.wasm pacman.c
 */

#define COLS 28
#define ROWS 31
#define TILE 16
#define WIDTH 448   /* COLS * TILE */
#define HEIGHT 496  /* ROWS * TILE */

/* directions : 0 = droite, 1 = gauche, 2 = haut, 3 = bas */
#define DIR_R 0
#define DIR_L 1
#define DIR_U 2
#define DIR_D 3
static const int DX[4] = { 1, -1, 0, 0 };
static const int DY[4] = { 0, 0, -1, 1 };
static const int OPP[4] = { DIR_L, DIR_R, DIR_D, DIR_U };
/* ordre de preference des fantomes en cas d'egalite : haut, gauche, bas, droite */
static const int PREF[4] = { DIR_U, DIR_L, DIR_D, DIR_R };

/* --- fonctions fournies par le JavaScript (dessin + sons) --- */
__attribute__((import_module("env"), import_name("js_clear")))
extern void js_clear(void);
__attribute__((import_module("env"), import_name("js_pellet")))
extern void js_pellet(int x, int y);
__attribute__((import_module("env"), import_name("js_power")))
extern void js_power(int x, int y);
__attribute__((import_module("env"), import_name("js_pac")))
extern void js_pac(int x, int y, int dir, int bouche);
__attribute__((import_module("env"), import_name("js_ghost")))
extern void js_ghost(int x, int y, int couleur, int mode);
__attribute__((import_module("env"), import_name("js_sfx")))
extern void js_sfx(int id);

/* --- etats du jeu --- */
enum { S_PRET, S_JEU, S_MORT, S_OVER, S_NIVEAU };

typedef struct { int px, py, dir, acc; } Ent;

typedef struct {
    Ent e;
    int couleur;            /* 0 Blinky, 1 Pinky, 2 Inky, 3 Clyde */
    int yeux;               /* 1 = fantome mange, retourne a la maison */
    int maison;             /* 1 = encore dans la maison des fantomes */
    int attente;            /* ticks restants avant de sortir */
    int coin_x, coin_y;     /* coin de dispersion (scatter) */
} Fantome;

static char laby[ROWS][COLS];

/* '#' mur, '.' gomme, 'o' super-gomme, '-' porte de la maison, ' ' vide */
static const char LABY0[ROWS][COLS] = {
    "############################",
    "#............##............#",
    "#.####.#####.##.#####.####.#",
    "#o####.#####.##.#####.####o#",
    "#.####.#####.##.#####.####.#",
    "#..........................#",
    "#.####.##.########.##.####.#",
    "#.####.##.########.##.####.#",
    "#......##....##....##......#",
    "######.##### ## #####.######",
    "     #.##### ## #####.#     ",
    "     #.##          ##.#     ",
    "     #.## ###--### ##.#     ",
    "######.## #      # ##.######",
    "      .   #      #   .      ",
    "######.## #      # ##.######",
    "     #.## ######## ##.#     ",
    "     #.##          ##.#     ",
    "     #.## ######## ##.#     ",
    "######.## ######## ##.######",
    "#............##............#",
    "#.####.#####.##.#####.####.#",
    "#.####.#####.##.#####.####.#",
    "#o..##.......  .......##..o#",
    "###.##.##.########.##.##.###",
    "###.##.##.########.##.##.###",
    "#......##....##....##......#",
    "#.##########.##.##########.#",
    "#.##########.##.##########.#",
    "#..........................#",
    "############################"
};

static Ent pac;
static int pac_voulue;
static Fantome fantomes[4];

static int score, vies, niveau, gommes;
static int etat, etat_timer;
static int peur, combo;                 /* super-gomme active + combo fantomes */
static int mode_idx, mode_timer, inverse;
static unsigned tick_count;

/* alternance dispersion / poursuite (en ticks a 60 Hz) */
static const int HORAIRE[8] = { 420, 1200, 420, 1200, 300, 1200, 300, 1 << 30 };

static char case_laby(int x, int y) {
    if (y < 0 || y >= ROWS || x < 0 || x >= COLS) return '#';
    return laby[y][x];
}

static int tunnel(int x, int y) {
    return y == 14 && (x < 0 || x >= COLS);
}

static int peut_pac(int x, int y) {
    char c;
    if (tunnel(x, y)) return 1;
    c = case_laby(x, y);
    return c != '#' && c != '-';
}

static int peut_fantome(int x, int y, int special) {
    char c;
    if (tunnel(x, y)) return 1;
    c = case_laby(x, y);
    if (c == '#') return 0;
    if (c == '-') return special; /* seuls les yeux / fantomes de la maison passent la porte */
    return 1;
}

static void charger_laby(void) {
    int x, y;
    gommes = 0;
    for (y = 0; y < ROWS; y++)
        for (x = 0; x < COLS; x++) {
            laby[y][x] = LABY0[y][x];
            if (laby[y][x] == '.' || laby[y][x] == 'o') gommes++;
        }
}

static void reset_positions(void) {
    int i;
    pac.px = 14 * TILE + 8;
    pac.py = 23 * TILE + 8;
    pac.dir = DIR_L;
    pac.acc = 0;
    pac_voulue = DIR_L;
    for (i = 0; i < 4; i++) {
        fantomes[i].e.acc = 0;
        fantomes[i].e.dir = DIR_L;
        fantomes[i].yeux = 0;
    }
    fantomes[0].e.px = 14 * TILE + 8; fantomes[0].e.py = 11 * TILE + 8;
    fantomes[0].maison = 0; fantomes[0].attente = 0;
    fantomes[1].e.px = 14 * TILE + 8; fantomes[1].e.py = 14 * TILE + 8;
    fantomes[1].maison = 1; fantomes[1].attente = 30;
    fantomes[2].e.px = 12 * TILE + 8; fantomes[2].e.py = 14 * TILE + 8;
    fantomes[2].maison = 1; fantomes[2].attente = 240;
    fantomes[3].e.px = 16 * TILE + 8; fantomes[3].e.py = 14 * TILE + 8;
    fantomes[3].maison = 1; fantomes[3].attente = 480;
    fantomes[0].couleur = 0; fantomes[1].couleur = 1;
    fantomes[2].couleur = 2; fantomes[3].couleur = 3;
    fantomes[0].coin_x = 26; fantomes[0].coin_y = 0;
    fantomes[1].coin_x = 1;  fantomes[1].coin_y = 0;
    fantomes[2].coin_x = 26; fantomes[2].coin_y = 29;
    fantomes[3].coin_x = 1;  fantomes[3].coin_y = 29;
    peur = 0; combo = 0;
    mode_idx = 0; mode_timer = HORAIRE[0]; inverse = 0;
}

/* cible d'un fantome selon son personnalité */
static void fantome_cible(int i, int *cx, int *cy) {
    Fantome *f = &fantomes[i];
    int px = pac.px / TILE, py = pac.py / TILE;
    if (f->yeux || f->maison) { *cx = 14; *cy = 11; return; }
    if ((mode_idx & 1) == 0) { *cx = f->coin_x; *cy = f->coin_y; return; }
    switch (i) {
    case 0: /* Blinky : poursuit Pac-Man */
        *cx = px; *cy = py;
        break;
    case 1: /* Pinky : vise 4 cases devant Pac-Man */
        *cx = px + DX[pac.dir] * 4;
        *cy = py + DY[pac.dir] * 4;
        break;
    case 2: { /* Inky : symétrique de Pac-Man par rapport a Blinky */
        int bx = fantomes[0].e.px / TILE, by = fantomes[0].e.py / TILE;
        int ax = px + DX[pac.dir] * 2, ay = py + DY[pac.dir] * 2;
        *cx = 2 * ax - bx;
        *cy = 2 * ay - by;
        break;
    }
    default: { /* Clyde : poursuit si loin, sinon retourne dans son coin */
        int dx = px - f->e.px / TILE, dy = py - f->e.py / TILE;
        if (dx * dx + dy * dy > 64) { *cx = px; *cy = py; }
        else { *cx = f->coin_x; *cy = f->coin_y; }
        break;
    }
    }
}

/* choisit la direction d'un fantome quand il est au centre d'une case */
static void fantome_decider(Fantome *f, int i, int tx, int ty) {
    int special = f->yeux || f->maison;
    int k, d, eff;
    if (inverse && !f->yeux && !f->maison) f->e.dir = OPP[f->e.dir];
    if (f->maison && f->attente > 0) {
        f->attente--;
        f->e.dir = (ty > 14) ? DIR_U : DIR_D; /* il patiente en haut/bas */
        return;
    }
    eff = f->yeux ? 4 : (peur > 0 ? 2 : ((mode_idx & 1) ? 0 : 1));
    if (eff == 2) { /* mode peur : direction aleatoire */
        int opts[4], n = 0;
        for (k = 0; k < 4; k++) {
            d = PREF[k];
            if (d == OPP[f->e.dir]) continue;
            if (peut_fantome(tx + DX[d], ty + DY[d], special)) opts[n++] = d;
        }
        if (n == 0) f->e.dir = OPP[f->e.dir];
        else f->e.dir = opts[(tick_count >> 3) % n];
        return;
    }
    {
        int cx, cy, best = -1, bestd = 1 << 30;
        fantome_cible(i, &cx, &cy);
        for (k = 0; k < 4; k++) {
            int ddx, ddy, dist;
            d = PREF[k];
            if (d == OPP[f->e.dir]) continue;
            if (!peut_fantome(tx + DX[d], ty + DY[d], special)) continue;
            ddx = tx + DX[d] - cx;
            ddy = ty + DY[d] - cy;
            dist = ddx * ddx + ddy * ddy;
            if (dist < bestd) { bestd = dist; best = d; }
        }
        f->e.dir = (best < 0) ? OPP[f->e.dir] : best;
    }
}

/* avance une entite de "vit/8" pixels par tick, case par case.
   vit = 16 -> 2 px/tick. Le deplacement se fait pixel par pixel pour
   passer exactement par le centre de chaque case. */
static void avancer(Ent *e, int vit, int est_pac, Fantome *f, int i) {
    e->acc += vit;
    while (e->acc >= 8) {
        e->acc -= 8;
        /* On decide au centre de la case AVANT de bouger : comme ca, une
           entite arretee face a un mur ne rentre jamais dans le mur. */
        if (e->px % TILE == 8 && e->py % TILE == 8) {
            int tx = e->px / TILE, ty = e->py / TILE;
            if (est_pac) {
                char c = laby[ty][tx];
                if (c == '.') {
                    laby[ty][tx] = ' '; gommes--; score += 10; js_sfx(0);
                } else if (c == 'o') {
                    laby[ty][tx] = ' '; gommes--; score += 50;
                    peur = 420 - niveau * 40;
                    if (peur < 90) peur = 90;
                    combo = 0; inverse = 1; js_sfx(1);
                }
                if (peut_pac(tx + DX[pac_voulue], ty + DY[pac_voulue]))
                    e->dir = pac_voulue;
                if (!peut_pac(tx + DX[e->dir], ty + DY[e->dir]))
                    return; /* mur : on reste au centre, on n'avance pas */
            } else {
                fantome_decider(f, i, tx, ty);
            }
        }
        e->px += DX[e->dir];
        e->py += DY[e->dir];
        if (e->px < 0) e->px += WIDTH;
        if (e->px >= WIDTH) e->px -= WIDTH;
    }
}

/* ---------------- API exportee vers le JavaScript ---------------- */

__attribute__((export_name("init_game")))
void init_game(void) {
    score = 0; vies = 3; niveau = 1; tick_count = 0;
    charger_laby();
    reset_positions();
    etat = S_PRET;
    etat_timer = 120;
}

__attribute__((export_name("start")))
void start(void) {
    if (etat == S_OVER) init_game();
    else if (etat == S_PRET) etat_timer = 1; /* saute l'ecran "PRET !" */
}

__attribute__((export_name("set_dir")))
void set_dir(int d) {
    if (d >= 0 && d < 4) pac_voulue = d;
}

__attribute__((export_name("tick")))
void tick(void) {
    int i, tx, ty;
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
            inverse = 1; /* changement de mode : les fantomes font demi-tour */
        }
        avancer(&pac, v_pac, 1, 0, 0);
        for (i = 0; i < 4; i++) {
            Fantome *f = &fantomes[i];
            int v = f->yeux ? 26 : (peur > 0 ? 10 : (f->maison ? 8 : v_fan));
            avancer(&f->e, v, 0, f, i);
            if (f->maison && !f->yeux && f->e.py / TILE <= 11) f->maison = 0;
            if (f->yeux && f->e.py / TILE == 11 &&
                (f->e.px / TILE == 13 || f->e.px / TILE == 14))
                f->yeux = 0; /* les yeux sont rentres : le fantome revit */
        }
        for (i = 0; i < 4; i++) {
            Fantome *f = &fantomes[i];
            int dx = f->e.px - pac.px, dy = f->e.py - pac.py;
            if (dx * dx + dy * dy < 144) {
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
            charger_laby();
            reset_positions();
            etat = S_PRET;
            etat_timer = 120;
        }
        break;
    case S_OVER:
        break;
    }

    /* --- rendu : on demande au JS de dessiner la scene --- */
    js_clear();
    for (ty = 0; ty < ROWS; ty++)
        for (tx = 0; tx < COLS; tx++) {
            char c = laby[ty][tx];
            if (c == '.') js_pellet(tx * TILE + 8, ty * TILE + 8);
            else if (c == 'o') js_power(tx * TILE + 8, ty * TILE + 8);
        }
    if (etat != S_MORT && etat != S_OVER)
        js_pac(pac.px, pac.py, pac.dir, (int)((tick_count >> 2) & 3));
    for (i = 0; i < 4; i++) {
        Fantome *f = &fantomes[i];
        int m;
        if (f->yeux) m = 4;
        else if (peur > 0) m = (peur < 120 && ((tick_count >> 4) & 1)) ? 3 : 2;
        else m = (mode_idx & 1) ? 0 : 1;
        js_ghost(f->e.px, f->e.py, f->couleur, m);
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

__attribute__((export_name("get_maze")))
const char *get_maze(void) { return &laby[0][0]; }
