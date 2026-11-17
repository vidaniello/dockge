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

> **Stato**: fatto, tranne quanto elencato qui sotto. Base comune (`backend/files.ts`) per API/MCP (`list_files`, `read_file`, `write_file`, `make_dir`, `move_file`, `delete_file`) e per il riquadro **File** della pagina dello stack (`frontend/src/components/StackFiles.vue`): cartella dello stack, volumi `./…` e volumi con percorso assoluto dentro `DOCKGE_BROWSE_ROOTS` (scrittura solo dove sono montati in scrittura); editor CodeMirror con gestione degli a capo (avviso e conversione CRLF → LF) e bit di esecuzione, salva e riavvia un servizio, upload a blocchi (anche trascinando, fino a 1 GiB), download, nuova cartella, rinomina, eliminazione.
> **Resta**: download di una cartella come archivio; console per singolo stack che parta nella sua cartella (punto 5).

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

## 5. Terminali: Console interattiva e miglioramenti del terminale dei servizi

### Console generale in modalità interattiva

Oggi la Console (`DOCKGE_ENABLE_CONSOLE=true`) è "a righe": il testo resta nel browser fino a Invio, poi la riga intera va a bash (`mode="mainTerminal"` in `frontend/src/components/Terminal.vue`, `MainTerminal` in `backend/terminal.ts`). Per questo non funzionano Tab, la cronologia con le frecce e i programmi che leggono un tasto alla volta (vim, nano, htop, less).

- Usare la modalità interattiva già usata dal terminale dei container: ogni tasto va subito alla shell (`onData` + `terminalInput`).
- La sicurezza non cambia: anche oggi è una bash completa con accesso al socket Docker. Resta attivabile solo con `DOCKGE_ENABLE_CONSOLE=true`.
- La shell gira dentro il container di Dockge: vede solo le cartelle montate e ha pochi programmi. Valutare se aggiungere all'immagine un editor (nano) e strumenti di base.
- Collegato al punto 4: una console per singolo stack che parta già nella sua cartella.

### Terminale dei servizi (pulsante "Bash")

È già interattivo. Possibili miglioramenti:

- **Shell automatica**: provare `bash` e, se non c'è (immagini Alpine / busybox), usare `sh` senza dover premere "Switch to sh".
- **Utente**: scegliere con quale utente entrare (es. `root`), utile quando l'immagine gira con un utente senza permessi (`docker compose exec --user`).
- **Più sessioni**: aprire più terminali sullo stesso servizio, in schede. Oggi il nome del terminale usa sempre l'indice 0 (`getContainerExecTerminalName(..., 0)`).

## 6. Sapere quale versione del fork è in esecuzione

L'immagine usata è `ghcr.io/vidaniello/dockge:latest` e in Impostazioni → Informazioni la versione è quella di `package.json` (1.5.0, la stessa dell'originale): non si capisce quale build del fork sta girando.

- **Informazioni di build nell'immagine**: il workflow `docker-image.yml` passa al build il commit (SHA corto), la data e il tag, per esempio come `--build-arg` salvati in variabili d'ambiente o in un file `build-info.json`. Dockge li mostra in Informazioni (con link al commit su GitHub), nel menu utente o a piè di pagina, e in `get_info` delle API.
- **Numerazione propria**: per esempio `1.5.0-vidaniello.N`, oppure tag `v1.6.0-fork.1`. Con un tag `v*` il workflow pubblica già le immagini `1.6.0` e `1.6`.
- **Controllo aggiornamenti di Dockge**: oggi chiede la versione a `dockge.kuma.pet`, cioè al progetto originale, e il pulsante "nuovo aggiornamento" porta alle release di louislam. Va puntato alle release del fork (API GitHub di `vidaniello/dockge`) oppure disattivato.
- **Oggi, senza modifiche**:
  - il workflow pubblica anche il tag `sha-<commit>`: usarlo al posto di `latest` sul server di prova per sapere esattamente cosa gira;
  - l'immagine ha già le etichette OCI con commit e data di build:

    ```bash
    docker image inspect ghcr.io/vidaniello/dockge:latest --format '{{index .Config.Labels "org.opencontainers.image.revision"}} {{index .Config.Labels "org.opencontainers.image.created"}}'
    ```

## 7. API / MCP: eseguire comandi nella cartella di uno stack

> **Stato**: fatto, `exec_in_stack_dir` (`POST /stacks/:name/exec`), solo con `DOCKGE_ENABLE_CONSOLE=true`. Resta da valutare la variante senza stack (cartella degli stack).

Oggi dalle API/MCP c'è solo `exec_in_service` (`backend/api/operations.ts`): esegue un comando dentro il container di un servizio, che deve essere avviato. Non si può eseguire un comando nella shell di Dockge (quella della Console), per esempio per lanciare `docker ...` o lavorare sui file di uno stack con i servizi fermi.

- **Nuovo strumento** (es. `exec_in_stack_dir`, `POST /stacks/:name/exec`): esegue un comando con `sh -c` / `bash -c` nel container di Dockge, partendo dalla cartella dello stack. Parametri come `exec_in_service`: `command`, `shell`, `timeoutSeconds`; risposta con `exitCode`, `stdout`, `stderr`, `timedOut`.
- **Sicurezza**: attivo solo con `DOCKGE_ENABLE_CONSOLE=true` (altrimenti lo strumento non compare né in REST né in MCP), chiave API con permesso di scrittura, segnato come `destructive`. Equivale all'accesso root all'host, come la Console.
- **Variante senza stack**: un comando nella cartella degli stack (`/opt/stacks`), come la Console generale.
- Non interattivo: un comando, una risposta. Limite di dimensione dell'output come gli altri strumenti (`limitOutput`).
- Collegato ai punti 4 (file dello stack via API) e 5 (Console).

## 8. Riquadri di avviso (`.alert`) a forma di pillola

Il riquadro con la chiave API appena creata (Impostazioni → Chiavi API, "Copia la chiave adesso: non verrà più mostrata") ha la forma di un ovale, è azzurro pieno e non segue lo stile delle altre schede. Non è l'unico caso: lo stesso problema riguarda tutti gli avvisi `.alert` dell'interfaccia.

**Causa**: in `frontend/src/styles/vars.scss` c'è `$border-radius: 50rem` (pensato per pulsanti e campi a pillola). Bootstrap 5.3 lo usa per molti componenti tramite `--bs-border-radius`, compresi gli `.alert`: con una riga sola diventano una pillola, con più righe un ovale che taglia il testo agli angoli.

**Controllo fatto** (CSS reale compilato da `main.scss`, tema chiaro e scuro):

| Dove | Riquadro | Risultato |
|---|---|---|
| `components/settings/ApiKeys.vue` (chiave nuova) | `alert alert-success` | ovale azzurro, pulsanti e testo che sfiorano il bordo curvo |
| `pages/Compose.vue` (finestra "Rinomina stack") | `alert alert-warning` | ovale, il testo su 3 righe tocca gli angoli |
| `components/PathPicker.vue` (scelta cartella dell'host) | `alert alert-danger py-2`, `alert alert-warning` | pillola; quello su 2 righe è ovale |
| `components/Login.vue` (credenziali errate) | `alert alert-danger` | pillola |
| `components/settings/About.vue` (versione frontend/backend diversa) | `alert alert-warning` | pillola (stesso stile, non visto a schermo) |
| `pages/Console.vue` ("Console non attiva") | `alert alert-warning shadow-box` | **ok**: `.shadow-box` rimette gli angoli a 10px |

Altri componenti che usano lo stesso raggio ma sono già corretti: `.list-group` (ridefinito a 0.75rem in `main.scss`), `.modal-content` (1rem), `.dropdown-menu` (0.5rem), campi e pulsanti (pillola voluta), textarea (angoli arrotondati ma accettabili).

**Problemi in più nel tema scuro**:
- gli avvisi restano chiari (giallo, rosa, azzurro): non esiste una variante scura per `.alert-warning` / `.alert-danger` / `.alert-success`;
- il testo in `<code>` dentro gli avvisi usa il colore chiaro del tema scuro sullo sfondo chiaro e quasi non si legge (es. `DOCKGE_ENABLE_CONSOLE=true` nella pagina Console, la chiave API nel riquadro della chiave nuova).

**Proposta**:
- in `main.scss` dare a `.alert` un raggio fisso (es. `border-radius: 10px`, come `.shadow-box`), oppure impostare `$alert-border-radius` prima dell'import di Bootstrap; non cambiare `$border-radius` globale, altrimenti cambiano anche pulsanti e campi;
- riquadro della chiave API: usarlo come le altre schede (`shadow-box big-padding`) con bordo o titolo di avviso, la chiave in un campo monospazio con "Copia" accanto;
- colori degli avvisi nel tema scuro (sfondo scuro con bordo colorato) e colore del `<code>` leggibile dentro gli avvisi;
- ricontrollare dopo la modifica le pagine della tabella, anche da telefono.

## 9. Chiavi API: indirizzo pubblico delle API dietro un reverse proxy

> **Stato**: fatto. Campo "Indirizzo pubblico delle API" in Impostazioni → Chiavi API e variabile `DOCKGE_API_PUBLIC_URL` (con precedenza; il campo diventa di sola lettura), usati per REST, OpenAPI, MCP e l'esempio MCP; indirizzo interno mostrato a parte; avviso con un proxy fidato e nessun indirizzo pubblico; validazione (`https://`, salvo `DOCKGE_API_ALLOW_HTTP=true`; niente `/api/v1` o `/mcp` finali).

Con le API dietro un reverse proxy HTTPS (es. Nginx Proxy Manager, con un nome dedicato come `dockge-api.test.trexon` che punta alla porta `DOCKGE_API_PORT` del container), il pannello Impostazioni → Chiavi API mostra un indirizzo sbagliato: `https://dockge.test.trexon:5002` invece di `https://dockge-api.test.trexon`.

- **Perché**: in `frontend/src/components/settings/ApiKeys.vue` (computed `baseURL`) l'indirizzo è costruito nel browser con il nome con cui si è aperto Dockge + `DOCKGE_API_PORT`. Dockge non può sapere con quale nome e porta le API si raggiungono dall'esterno. Sono sbagliati gli indirizzi REST, OpenAPI e MCP e l'esempio di configurazione per il client MCP.
- **Lato server va già bene** (verificato in `backend/api/api-router.ts` e `backend/dockge-server.ts`):
  - HTTPS riconosciuto con `X-Forwarded-Proto: https` se il proxy è in `DOCKGE_TRUST_PROXY`;
  - IP del client da `X-Forwarded-For` (blocco dopo 10 tentativi falliti);
  - nessun controllo su `Host` / `Origin`, quindi un nome diverso funziona;
  - `openapi.json` ha `servers: [{ url: "/api/v1" }]`, relativo, valido con qualsiasi dominio.
- **Proposta**:
  - variabile `DOCKGE_API_PUBLIC_URL` (es. `https://dockge-api.test.trexon`) e/o campo "Indirizzo pubblico delle API" nel pannello, salvato nelle impostazioni (la variabile, se presente, ha la precedenza e il campo è in sola lettura);
  - il backend la restituisce in `getApiKeyList` (`config.publicUrl`, in `backend/socket-handlers/main-socket-handler.ts`); il pannello la usa per REST, OpenAPI, MCP e l'esempio MCP;
  - mostrare anche l'indirizzo interno (porta del container) come informazione, e un avviso se c'è un proxy fidato ma nessun indirizzo pubblico impostato;
  - validare l'indirizzo (solo `https://`, salvo `DOCKGE_API_ALLOW_HTTP=true`; niente percorso finale `/api/v1` o `/mcp`);
  - aggiornare la tabella delle variabili e la sezione sul reverse proxy in `docs/FORK.md`.
- Valutare lo stesso per l'interfaccia web senza porta dedicata (API su `/api` e `/mcp` della porta principale): lì `location.origin` va già bene se si apre Dockge dal nome pubblico.

## 10. docker compose: controllo automatico delle nuove versioni

L'immagine fissa `docker compose` alla v5.0.2 (`docker/Dockerfile`): dalla v5.1.0 (provate fino alla v5.6.1) compose si ferma con `ParseAddr("…::1/64"): unexpected character, want colon` perché il demone Docker di TrueNAS restituisce il gateway IPv6 delle reti con il prefisso. Senza controllo resteremmo bloccati sulla v5.0.2 anche quando il problema verrà corretto.

- **Test riproducibile**: uno script (es. `extra/test-compose-ipv6-gateway.ts`) avvia un finto Docker Engine API su socket Unix che risponde a `/_ping`, `/version`, `/networks`, `/containers/json`… con una rete del progetto che ha `IPAM.Config[].Gateway = "fdfe:b4b:2e4b:c::1/64"`, poi esegue `docker compose up -d --pull never` su un compose minimo con `DOCKER_HOST` puntato al socket. Esito: errore `ParseAddr` = versione non compatibile; qualsiasi altro errore successivo (es. creazione del container non implementata) = la rete è stata letta, compatibile.
- **Workflow GitHub Actions** pianificato (es. una volta a settimana): legge l'ultima release di `docker/compose`, scarica il binario e `checksums.txt`, esegue il test.
  - Se la nuova versione è compatibile: apre una issue (o una PR che aggiorna versione e SHA-256 delle tre architetture nel `Dockerfile`).
  - Se non lo è: niente, o un commento sulla issue esistente con la versione provata.
- Lo stesso test si può eseguire nella CI quando cambia il `Dockerfile`, per evitare di aggiornare per sbaglio a una versione non compatibile.
- Valutare anche la segnalazione a monte (docker/compose o moby): il demone accetta e restituisce quel formato, il client nuovo no.

## 11. Home: riepilogo degli stack gestiti e delle altre risorse

La home (`frontend/src/pages/DashboardHome.vue`) conta tutti gli stack, compresi quelli non gestiti da Dockge.

- Contare solo gli stack gestiti (attivi / fermi / con errori / con aggiornamenti delle immagini), e mostrare a parte, più piccolo, quanti stack non gestiti ci sono.
- Aggiungere riepiloghi per le altre risorse, letti dall'API Docker (`backend/docker-api.ts`) e non dalla CLI:
  - servizi / container (in esecuzione, fermi, unhealthy);
  - volumi (quanti, quelli non usati da nessun container);
  - reti (quante, quelle non usate);
  - immagini (quante, spazio occupato, quelle non usate);
  - con ZFS: dataset degli stack, snapshot, spazio libero della cartella degli stack.
- Ogni riquadro porta, dove ha senso, all'elenco filtrato.
- Per gli agent: un riepilogo per ciascun endpoint.

## 12. Impostazioni: controllo completo del tema chiaro e scuro

In alcune pagine delle Impostazioni, nel tema scuro qualcosa non si legge bene, e nel tema chiaro alcuni campi sono rimasti con i colori del tema scuro.

- Passare tutte le voci del menu (Generale, Aspetto, Sicurezza, Global .env, Chiavi API, Archiviazione, Informazioni) nei due temi, con screenshot prima e dopo.
- Cercare i colori fissi nel codice (es. `#6c757d`, sfondi scuri scritti direttamente nei componenti) e sostituirli con le variabili di `frontend/src/styles/vars.scss` e con regole `.dark &`.
- Collegato al punto 2 (campi di input scuri nel tema chiaro) e al punto 8 (avvisi a pillola).

## 13. Leggibilità: selezione del testo nel tema chiaro e segnaposto nel tema scuro

- **Tema chiaro**: la selezione del testo nei campi editabili (input, textarea, editor CodeMirror) si vede poco. Controllare `.cm-selectionBackground` in `frontend/src/styles/main.scss` e aggiungere un colore di `::selection` per input e textarea con contrasto sufficiente.
- **Tema scuro**: alcuni segnaposto (placeholder) sono poco leggibili, ad esempio quello del campo "Docker Run" (`docker run ...`, `textarea.docker-run` in `frontend/src/pages/DashboardHome.vue`) sopra il pulsante "Converti a compose". Definire un colore dei placeholder per il tema scuro valido per tutti i campi.

## 14. Eliminazione di uno stack dataset: dataset elencati due volte

Nella finestra di eliminazione (e nel messaggio d'errore) ogni dataset compare due volte:

```
pool1/dockge_custom/stacks/zftest2-clone2
pool1/dockge_custom/stacks/zftest2-clone2/db
pool1/dockge_custom/stacks/zftest2-clone2/html
pool1/dockge_custom/stacks/zftest2-clone2
...
```

- **Causa probabile**: `datasetsInside()` in `backend/zfs/datasets.ts` restituisce una voce per ogni mount trovato in `/proc/self/mountinfo`, e nel container di Dockge lo stesso dataset è montato due volte nello stesso punto: una attraverso il bind della cartella degli stack (`rslave`), una attraverso il bind di `/mnt` per il selettore di percorsi. Da verificare sul NAS con `docker exec dockge grep zftest2 /proc/self/mountinfo`.
- **Correzione**: togliere i doppioni in `datasetsInside()` (e controllare gli altri punti che contano i mount: `mountsInside`, ricerca dei dati nascosti, `planStackDatasetRename`).

## 15. Eliminazione di uno stack dataset: l'opzione "conserva i dati" non è chiara e finisce in errore

"Rimuovi solo i container e conserva i dati (lo stack resta nell'elenco)" esegue `docker compose down` e poi si ferma, perché la cartella è un dataset. Il risultato è quello promesso: container rimossi, dati e stack intatti. Ma viene riportato come un errore ("The containers were removed. The stack folder is (or contains) a ZFS dataset…"), e non è chiaro a cosa serva.

- **Decidere** se tenerla:
  - **toglierla**: "Elimina" su uno stack dataset elimina sempre tutto, dopo la conferma; per fermare e rimuovere i container c'è già "Down" nel menu dello stack;
  - **oppure** rinominarla in qualcosa come "Rimuovi i container (come Down) e lascia lo stack e i dati", e farla finire con un messaggio di successo, non di errore.
- In ogni caso il messaggio d'errore lato API (`delete_stack` con `datasets: "keep"`) va riscritto: oggi sembra un fallimento.
