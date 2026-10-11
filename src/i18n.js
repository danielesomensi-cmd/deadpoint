// UI strings. English is the default (GitHub Pages, climbritz.app/gioco and the Climbritz app,
// which embeds the game with `?lang=en&embed=1`); `?lang=it` switches to Italian. Grade labels are not
// translated. `t(key, ...args)`: plain strings or functions of args.
const params = (() => { try { return new URLSearchParams(window.location.search); } catch (e) { return new URLSearchParams(); } })();

export const LANG = params.get('lang') === 'it' ? 'it' : 'en';
// Embedded in a host app (iframe): the host owns safe areas and navigation. Nothing in the game
// reads window.top or opens external links, so this only tags <html> for styling hooks.
export const EMBED = params.get('embed') === '1';

const S = {
  it: {
    metaDesc: 'Deadpoint: gioco 3D di arrampicata su board LED. Prendi le prese nel punto morto del lancio e gestisci la ghisa.',
    ariaTries: 'Tentativi', ariaPause: 'Pausa', ariaMain: 'Muovi', ariaRest: 'Scuoti le braccia', restLabel: 'SCUOTI',
    forearms: 'AVAMBRACCI', pump: 'GHISA',
    titleEyebrow: 'Board LED regolabile · 20°–70°',
    lede: 'Prendi ogni presa nel punto morto del lancio, gestisci la ghisa e chiudi il blocco con le mani sul top.',
    legStart: 'Partenza', legHand: 'Mani e piedi', legFinish: 'Top', legFoot: 'Solo piedi',
    how1: '<b>Tocca il pulsante</b> per lanciarti verso la presa illuminata.',
    how2: '<b>Guarda la scalatrice</b>: carica due volte, spinge, e <b>tocca quando si ferma in alto</b> con la mano aperta sulla presa. <small>Tic, tic, TAC: si tocca sul TAC. Perfetto = meno fatica.</small>',
    how3: '<b>Su una maniglia</b> martella il tasto a destra per scuotere le braccia. <small>Più veloce = più recupero. Solo sulle maniglie.</small>',
    startFrom: 'Parti da', btnStart: 'Inizia sessione', btnDaily: 'Blocco del giorno', btnMenu: 'Menu',
    dailyTitle: 'Blocco del giorno', dailyAgain: 'Riprova il blocco del giorno',
    dailyTopped: (n) => n === 1 ? 'Chiuso al primo tentativo: flash!' : `Chiuso al tentativo ${n}`,
    dailyFailed: 'Non chiuso oggi. Domani un blocco nuovo, oppure riprova.',
    dailyDone: (pts, n) => `oggi chiuso ✓ ${pts} punti (${n}°)`, dailyBestOnly: (pts) => `oggi: ${pts} punti`,
    dailyStreak: (n) => `serie <b>${n}</b> ${n === 1 ? 'giorno' : 'giorni'}`,
    cardDaily: (k, a, m) => `BLOCCO DEL GIORNO ${k} · TENTATIVO ${a} DI ${m}`,
    sessionOver: 'Sessione finita', boardCleared: 'Board chiusa, complimenti',
    statPoints: 'Punti', statFlash: 'Flash', statBest: 'Record',
    restartFrom: 'Riparti da', btnAgain: 'Nuova sessione',
    paused: 'In pausa', pauseBig: 'PAUSA', btnResume: 'Riprendi', btnQuit: 'Esci',
    soundOn: 'Audio: sì', soundOff: 'Audio: no',
    noWebgl: 'Questo dispositivo non supporta WebGL, serve per la grafica 3D del gioco.',
    // quality / timing
    perfect: 'PERFETTO', good: 'BUONA', ok: 'SPORCA', miss: 'MANCATA',
    early: (ms) => `presto ${ms} ms`, late: (ms) => `tardi ${ms} ms`,
    tooEarly: 'TROPPO PRESTO', tooLate: 'TROPPO TARDI',
    whyPump: 'Ghisato: scuoti le braccia sulle maniglie', whyEarly: 'Troppo presto', whyLate: 'Troppo tardi',
    fell: 'CADUTO', attemptOf: (n, m) => `tentativo ${n} di ${m}`,
    topGrade: (f, a) => `Grado massimo ${f} a ${a}°`, newRecord: ' · nuovo record',
    noSends: 'Nessun blocco chiuso. Il primo è sempre il più difficile.',
    attemptsN: (n) => `${n} tentativi`, attemptShort: (n) => `${n}°`,
    pumped: 'GHISATO', outOfEnergy: 'energia finita', energyCost: (c) => `−${c} energia`,
    feetBang: 'PIEDI!', feet: 'PIEDI', feetMissed: 'PIEDI MANCATI', matchMissed: 'MATCH MANCATO', match: 'MATCH',
    onTheEdge: ' · al limite!', topLine: (pts, p, m, edge) => `+${pts} punti · perfetti ${p}/${m}${edge}`,
    rhythm: 'RITMO PRESO', noSlowmo: 'Da qui in poi niente rallentatore',
    tapNow: 'TOCCA ORA!', tapApex: 'Tocca quando si ferma in alto',
    dyno: 'LANCIO', feetCut: 'PIEDI FUORI',
    problemN: (n) => `Blocco ${n}`,
    hintFirst: 'Tocca per lanciarti verso la presa', hintStart: 'Tocca per partire',
    hintRest: 'Maniglia: martella SCUOTI per recuperare', hintNoRest: 'Qui non si recupera: muoviti',
    hintNext: 'Tocca per la prossima presa', hintShake: 'Martella più veloce… poi tocca il tasto grande',
    hintFeet: 'Piedi fuori: tocca quando tornano sul muro',
    hintMatch: 'Porta la seconda mano sul top',
    allez: 'Allez!', allezTap: 'tocca!', bubAria_allez: 'Allez', allezUp: 'ALLEZ!', allezSub: (n) => `+${n} energia · prese più facili`,
    tip_allez: 'Il tuo amico ti incita: tocca il fumetto per energia extra!',
    bubJump: 'SALTO', bubAria_jump: 'Salto', jump: 'SALTO', jumpArmed: 'SALTO!', jumpSub: 'salti una presa · punti ×2.5',
    tip_jump: 'Bolla SALTO: toccala prima che finisca e salti una presa con un lancio.',
    bubChalk: 'MAGNESITE', bubAria_chalk: 'Magnesite',
    chalkUp: 'MAGNESITE', chalkSub: (n) => `prese più facili ×${n}`,
    tip_chalk: 'Tocca la bolla: magnesite! Prossime 3 prese più facili.',
    tipMain: 'Un tasto solo: lancio, presa, piedi, match. Tocca sul TAC.',
    tipRest: 'Sei su una maniglia: martella questo tasto per recuperare energia.',
    nextTop: 'Top', nextHold: 'Prossima',
    cardHead: (n, a, m) => `BLOCCO ${n} · TENTATIVO ${a} DI ${m}`,
    cardSub: (ang, mv) => `· board a ${ang}° · ${mv} movimenti`, tapToStart: 'TOCCA PER INIZIARE',
    recordLine: (g, pts) => `Record: <b>${g}</b> · <b>${pts}</b> punti. Tre tentativi per blocco.`,
    introLine: "Tre tentativi per blocco. Meglio con l'audio.",
    holds: { jug: 'Maniglia', edge: 'Listino', pinch: 'Pinza', crimp: 'Tacchetta', sloper: 'Svaso', chip: 'Appoggio' },
  },
  en: {
    metaDesc: 'Deadpoint: a 3D climbing game on an LED board. Catch each hold at the deadpoint of the move and manage the pump.',
    ariaTries: 'Attempts', ariaPause: 'Pause', ariaMain: 'Move', ariaRest: 'Shake out', restLabel: 'SHAKE',
    forearms: 'FOREARMS', pump: 'PUMP',
    titleEyebrow: 'Adjustable LED board · 20°–70°',
    lede: 'Catch every hold at the deadpoint of the move, manage the pump and top out with both hands on the finish.',
    legStart: 'Start', legHand: 'Hands and feet', legFinish: 'Top', legFoot: 'Feet only',
    how1: '<b>Tap the button</b> to launch toward the lit hold.',
    how2: '<b>Watch the climber</b>: she loads twice, drives, and <b>you tap when she stops at the top</b> with her hand open on the hold. <small>Tick, tick, TOCK: tap on the TOCK. Perfect = less pump.</small>',
    how3: '<b>On a jug</b>, mash the button on the right to shake out. <small>Faster = more recovery. Jugs only.</small>',
    startFrom: 'Start from', btnStart: 'Start session', btnDaily: 'Daily problem', btnMenu: 'Menu',
    dailyTitle: 'Daily problem', dailyAgain: 'Try the daily again',
    dailyTopped: (n) => n === 1 ? 'Sent first go: flash!' : `Sent on attempt ${n}`,
    dailyFailed: 'Not sent today. New problem tomorrow, or try again.',
    dailyDone: (pts, n) => `today sent ✓ ${pts} pts (#${n})`, dailyBestOnly: (pts) => `today: ${pts} pts`,
    dailyStreak: (n) => `streak <b>${n}</b> ${n === 1 ? 'day' : 'days'}`,
    cardDaily: (k, a, m) => `DAILY PROBLEM ${k} · ATTEMPT ${a} OF ${m}`,
    sessionOver: 'Session over', boardCleared: 'Board cleared, well done',
    statPoints: 'Points', statFlash: 'Flash', statBest: 'Best',
    restartFrom: 'Restart from', btnAgain: 'New session',
    paused: 'Paused', pauseBig: 'PAUSE', btnResume: 'Resume', btnQuit: 'Quit',
    soundOn: 'Sound: on', soundOff: 'Sound: off',
    noWebgl: 'This device does not support WebGL, which the game needs for its 3D graphics.',
    perfect: 'PERFECT', good: 'GOOD', ok: 'SLOPPY', miss: 'MISSED',
    early: (ms) => `early ${ms} ms`, late: (ms) => `late ${ms} ms`,
    tooEarly: 'TOO EARLY', tooLate: 'TOO LATE',
    whyPump: 'Pumped: shake out on the jugs', whyEarly: 'Too early', whyLate: 'Too late',
    fell: 'FELL', attemptOf: (n, m) => `attempt ${n} of ${m}`,
    topGrade: (f, a) => `Top grade ${f} at ${a}°`, newRecord: ' · new record',
    noSends: 'No problems sent. The first one is always the hardest.',
    attemptsN: (n) => `${n} attempts`, attemptShort: (n) => `#${n}`,
    pumped: 'PUMPED', outOfEnergy: 'out of energy', energyCost: (c) => `−${c} energy`,
    feetBang: 'FEET!', feet: 'FEET', feetMissed: 'FEET MISSED', matchMissed: 'MATCH MISSED', match: 'MATCH',
    onTheEdge: ' · on the edge!', topLine: (pts, p, m, edge) => `+${pts} points · perfect ${p}/${m}${edge}`,
    rhythm: 'GOT THE RHYTHM', noSlowmo: 'No more slow motion from here',
    tapNow: 'TAP NOW!', tapApex: 'Tap when she stops at the top',
    dyno: 'DYNO', feetCut: 'FEET CUT',
    problemN: (n) => `Problem ${n}`,
    hintFirst: 'Tap to launch toward the hold', hintStart: 'Tap to start',
    hintRest: 'Jug: mash SHAKE to recover', hintNoRest: 'No rest here: keep moving',
    hintNext: 'Tap for the next hold', hintShake: 'Mash faster… then hit the big button',
    hintFeet: 'Feet cut: tap when they swing back to the wall',
    hintMatch: 'Bring the second hand to the top',
    allez: 'Allez!', allezTap: 'tap!', bubAria_allez: 'Allez', allezUp: 'ALLEZ!', allezSub: (n) => `+${n} energy · easier catches`,
    tip_allez: 'Your friend is cheering: tap the bubble for a boost!',
    bubJump: 'JUMP', bubAria_jump: 'Jump', jump: 'JUMP', jumpArmed: 'JUMP!', jumpSub: 'skip a hold · points ×2.5',
    tip_jump: 'JUMP bubble: tap it before it runs out to skip a hold with one big dyno.',
    bubChalk: 'CHALK', bubAria_chalk: 'Chalk up',
    chalkUp: 'CHALKED', chalkSub: (n) => `easier catches ×${n}`,
    tip_chalk: 'Tap the bubble to chalk up: the next 3 catches get easier.',
    tipMain: 'One button does it all: launch, catch, feet, match. Tap on the TOCK.',
    tipRest: 'You are on a jug: mash this button to win back energy.',
    nextTop: 'Top', nextHold: 'Next',
    cardHead: (n, a, m) => `PROBLEM ${n} · ATTEMPT ${a} OF ${m}`,
    cardSub: (ang, mv) => `· board at ${ang}° · ${mv} moves`, tapToStart: 'TAP TO START',
    recordLine: (g, pts) => `Best: <b>${g}</b> · <b>${pts}</b> points. Three attempts per problem.`,
    introLine: 'Three attempts per problem. Better with sound on.',
    holds: { jug: 'Jug', edge: 'Edge', pinch: 'Pinch', crimp: 'Crimp', sloper: 'Sloper', chip: 'Foothold' },
  },
};

// Problem names: same list lengths as NAME_A/NAME_B in logic.js (indices come from the generator,
// so the RNG sequence is identical in both languages). English reads "<B> <A>".
const NAMES_EN = {
  A: ['Pump', 'Crimp', 'Sloper', 'Dyno', 'Pinch', 'Chalk', 'Deadpoint', 'Flight', 'Jump',
    'Shoulder', 'Jug', 'Heel Hook', 'Overhang', 'Slab', 'Drop Knee', 'Lock-off', 'Campus', 'Gaston'],
  B: ['Gentle', 'Wicked', 'Fierce', 'Elegant', 'Wobbly', 'Neon', 'Footless', 'Velvet',
    'Bar-room', 'Sunday', 'Midnight', 'Elite', 'Late', 'Chalky', 'Explosive', 'Razor-edge',
    'Sublime', 'Surprise'],
};

const TABLE = S[LANG];
export function t(key, ...args) {
  const v = TABLE[key];
  return typeof v === 'function' ? v(...args) : v;
}
export const holdName = (type) => TABLE.holds[type];
export const fmtLocale = LANG === 'en' ? 'en-US' : 'it-IT';
export function problemName(pr) {
  if (LANG !== 'en' || !pr.nameIdx) return pr.name;
  return NAMES_EN.B[pr.nameIdx[1]] + ' ' + NAMES_EN.A[pr.nameIdx[0]];
}

// Static HTML: elements carry data-i18n (innerHTML) / data-i18n-aria (aria-label).
// index.html still holds the Italian text; the active table always overwrites it.
export function applyDom(doc = document) {
  doc.documentElement.lang = LANG;
  if (EMBED) doc.documentElement.dataset.embed = '1';
  const meta = doc.querySelector('meta[name="description"]');
  if (meta) meta.setAttribute('content', TABLE.metaDesc);
  for (const el of doc.querySelectorAll('[data-i18n]')) el.innerHTML = TABLE[el.dataset.i18n];
  for (const el of doc.querySelectorAll('[data-i18n-aria]')) el.setAttribute('aria-label', TABLE[el.dataset.i18nAria]);
}

export const STRINGS = S; // for checks
