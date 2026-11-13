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
