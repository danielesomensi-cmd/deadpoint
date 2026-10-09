# Deadpoint

Gioco 3D di arrampicata su una board LED regolabile (stile Kilter). Si gioca dal browser, anche da telefono.

**Gioca:** https://danielesomensi-cmd.github.io/deadpoint/

## Come si gioca

1. **Tocca** per lanciarti verso la presa illuminata.
2. **Tocca di nuovo quando l'anello si chiude** sulla presa: è il *deadpoint*, l'istante in cui il corpo è senza peso. Perfetto = meno fatica.
3. **Tieni premuto** sulle prese buone per scuotere le braccia e recuperare. Sulle tacchette non si recupera.

Sessione a piramide da 4 / V0 (board a 20°) fino a 8B / V13 (70°), tre tentativi per blocco. Nei blocchi duri ci sono lanci, piedi che partono (tocca quando l'anello giallo si chiude) e il match finale sul top.

Colori LED come sulla Kilter: verde partenza, turchese mani e piedi, magenta top, giallo solo piedi.

Da tastiera: barra spaziatrice o Invio per toccare, Esc per la pausa.

## Sviluppo

```bash
npm install
npm run dev        # server locale con ricarica automatica (anche da telefono sulla stessa rete)
npm run build      # dist/index.html: un unico file autosufficiente
npm test           # generatore + bilanciamento + build + partita giocata da un bot
```

Dettagli su architettura, test e convenzioni in [CLAUDE.md](CLAUDE.md).

Ogni push su `main` ripubblica il gioco su GitHub Pages (`.github/workflows/deploy.yml`).
