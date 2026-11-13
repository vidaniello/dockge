# Backlog

## 1. Barra laterale: gli stack non devono riordinarsi quando cambia lo stato

Quando uno stack cambia stato (attivo, inattivo, fermo) si sposta in alto o in basso nella barra laterale: Dockge ordina di default gli stack per stato. In questa versione deve valere solo l'ordine scelto dall'utente: gli stack non devono riordinarsi da soli.

- Dove: `frontend/src/components/StackList.vue`, computed `agentStackList`. La lista è ordinata per "gestito da Dockge", poi per stato (`RUNNING`, `EXITED`, `CREATED_STACK`, ...), poi per nome; quell'ordine diventa l'ordine di default degli stack non ancora ordinati a mano in `buildFolderTree()`.
- Proposta: ordine di default solo alfabetico (cartelle, poi stack per nome). Lo stato non deve influire; gli stack ordinati a mano mantengono la posizione salvata (`stackFolderOrder`).

## 2. Tema chiaro: alcuni campi di input restano scuri

In modalità chiara alcuni campi restano con lo sfondo scuro, sicuramente quelli della scheda che si apre premendo "Modifica" su un servizio di uno stack.

- Dove guardare: `frontend/src/components/ArrayInput.vue` e `ArraySelect.vue` (`.list-group` e `.domain-input` usano `$dark-bg2` / `$dark-font-color` senza distinguere il tema), `Container.vue`, `NetworkInput.vue`.
- Verificare tutta la scheda di modifica del servizio (immagine, porte, volumi, variabili, reti, dipendenze) e le altre pagine con il tema chiaro.

## 3. Pull request all'originale o versione propria?

Decidere se proporre le modifiche al progetto originale (louislam/dockge) oppure proseguire con questa versione.

Cose da valutare:
- Le regole per i contributi dell'originale (`CONTRIBUTING.md`) e cosa accetta: pull request piccole e separate, una funzionalità alla volta, di solito discusse prima in una issue. Questo fork ha molte modifiche insieme (UI, API, MCP, cartelle, aggiornamenti immagini).
- Alcune parti sono correzioni utili a tutti e facili da proporre da sole, per esempio: copia e incolla nei terminali su HTTP, `.env` non salvato, crash delle porte in sintassi lunga, `docker network ls` con il client 29, compose.yaml riscritto entrando in modifica.
- Altre sono scelte personali o più grandi (API REST/MCP, cartelle, controllo aggiornamenti, ordinamento manuale) e potrebbero non essere accettate o richiedere molte revisioni.
- Mantenere una versione propria significa riportare a mano gli aggiornamenti dell'originale (merge periodici e conflitti) e pubblicare la propria immagine (già fatto con GHCR).
- Possibile via di mezzo: proporre all'originale solo le correzioni, una pull request per ciascuna, e tenere qui le funzionalità più grandi.

## 4. Gestione dei file dello stack

Spesso i servizi hanno bisogno di file di configurazione. Ragionare su un gestore di file nella pagina dello stack:

- **Navigazione e cartelle**: elenco di file e cartelle della cartella dello stack; creare, rinominare, spostare ed eliminare file e sottocartelle.
- **Upload / download**: caricare file (anche più di uno, trascinandoli) e scaricarli; per le cartelle, download come archivio.
- **Piccolo editor di testo**: aprire un file, modificarlo, salvarlo e poi, con un pulsante, riavviare il servizio che lo usa. Si può riusare l'editor CodeMirror già usato per compose.yaml, con evidenziazione in base all'estensione.
- **A capo di Windows (CRLF)**: gli script `.sh` con `\r\n` non partono (`/bin/sh^M: bad interpreter`).
  - L'editor lavora già internamente con `\n`, quindi il testo incollato da Windows viene normalizzato; controllare che al salvataggio venga scritto con `\n`.
  - Per i file caricati: rilevare CRLF (e il BOM UTF-8) e proporre la conversione, almeno per `.sh`, `.env`, `.yaml`, `.conf`; mostrare nell'editor il tipo di a capo del file (LF / CRLF) e permettere di cambiarlo.
  - Bit di esecuzione per gli script (`chmod +x`) e proprietario dei file (`PUID` / `PGID`, come per compose.yaml).
- **Sicurezza**: restare dentro la cartella dello stack (percorsi risolti, niente `..` né link simbolici che escono), limite di dimensione, i file binari solo in download.
- **File fuori dallo stack**: chi usa percorsi assoluti dell'host nei bind mount (es. `/mnt/pool/...`) ha i file di configurazione lì, non nella cartella dello stack. Valutare di permettere anche le cartelle di `DOCKGE_BROWSE_ROOTS`; oggi sono montate in sola lettura e andrebbero montate in scrittura.
- **API / MCP**: esporre lettura e scrittura dei file (es. `list_files`, `read_file`, `write_file`), così un assistente AI può correggere una configurazione e riavviare il servizio.
- **Comandi nella cartella dello stack**: Dockge ha già una "Console" (attiva con `DOCKGE_ENABLE_CONSOLE=true`). Non è SSH: è una shell bash dentro il container di Dockge, che parte dalla cartella degli stack e ha il client `docker`. L'input viene inviato una riga alla volta, quindi niente completamento con Tab né programmi a schermo intero (vim, nano). Valutare:
  - una console per singolo stack che parta già nella sua cartella;
  - una modalità interattiva completa, come quella del terminale dei container.
