# Design: dataset ZFS per stack e volumi

Stato: fasi 1, 2 e 3 implementate; fase 4 da fare (§13).

Obiettivo: quando la cartella degli stack è su ZFS (in particolare su TrueNAS SCALE), Dockge crea e gestisce i dataset di stack e volumi. Nel compose si scrivono percorsi relativi (`./library`) invece di `/mnt/pool/...`, e diventano possibili snapshot, rollback e clone per stack.

## 1. Il problema di partenza

Su Linux, montare un dataset su una cartella che contiene già dati o fallisce o riesce nascondendo i dati sotto il mount (con `overlay=on`, default di OpenZFS recente). Ne seguono due regole:

- **un dataset va creato prima che la cartella esista**;
- **una cartella esistente non si converte, si migra** (sposta da parte → crea il dataset → ricopia → verifica).

Trappola collegata: con la sintassi corta `./data:/data`, se `./data` non esiste **Docker la crea da solo** come cartella normale al primo `up`. Dockge deve quindi intervenire prima del deploy.

## 2. Layout

La gerarchia dei dataset ricalca quella degli stack:

```
pool/stacks                  ← DOCKGE_STACKS_DIR=/mnt/pool/stacks (creato dall'utente prima di Dockge)
pool/stacks/immich           ← dataset dello stack: compose.yaml, .env
pool/stacks/immich/library   ← volume ./library  (recordsize=1M)
pool/stacks/immich/pgdata    ← volume ./pgdata   (recordsize=16K)
```

```yaml
services:
  server:
    volumes:
      - ./library:/usr/src/app/upload
  database:
    volumes:
      - ./pgdata:/var/lib/postgresql/data
```

I percorsi relativi funzionano già oggi: compose li risolve rispetto alla cartella dello stack, che ha lo stesso percorso dentro e fuori dal container di Dockge.

**Perché anche lo stack deve essere un dataset.** ZFS è gerarchico: `pool/stacks/immich/library` esiste solo se esiste il dataset `pool/stacks/immich`. Se `immich` è una cartella normale, crearne il dataset la coprirebbe (compose compreso). Un mountpoint personalizzato sarebbe l'alternativa, ma TrueNAS li gestisce male. Quindi:

- **cartella stacks = radice di un dataset** è un prerequisito;
- **stack = dataset** è la base per avere volumi come dataset.

Vantaggi:

- snapshot ricorsivo dello stack = compose + `.env` + dati nello stesso istante;
- proprietà per volume (recordsize, compression, atime, quota);
- replica e backup per stack con i task di TrueNAS;
- clone di uno stack per provare un aggiornamento.

## 3. Come Dockge comanda ZFS

`zfs create` eseguito dentro un container monta il dataset nel namespace dei mount del container, non dell'host: non va usato. Un'unica interfaccia (`ZfsProvider`) con queste implementazioni:

1. **API di TrueNAS** (prima e principale). JSON-RPC 2.0 su WebSocket (`wss://<host>/api/current`, da 25.04; prima `/websocket`) con una chiave API. Il middleware crea e monta sull'host, applica preset e permessi, i dataset compaiono nella UI. Metodi: `pool.dataset.create/query/update/delete/rename`, `pool.snapshot.*`, `filesystem.setperm`, `filesystem.listdir`, `user.query`, `group.query`.
2. **Host ZFS generico** (Proxmox, Ubuntu…, in un secondo momento). Dockge ha già il socket Docker: avvia un container di servizio privilegiato con `--pid=host` ed esegue `nsenter -t 1 -m -- zfs ...` con lo `zfs` dell'host. Su TrueNAS non va usato perché scavalca il middleware.
3. Dockge installato direttamente sull'host: `zfs` diretto.

### Rilevamento

Tutto da dentro il container, senza binari ZFS:

- `fs.statfsSync(stacksDir).type === 0x2fc12fc2` → filesystem ZFS;
- `/proc/self/mountinfo` → nome del dataset (campo source), e se la cartella stacks è la radice del dataset (campo root = `/`) o una sua sottocartella;
- `/proc/self/mountinfo` → propagazione (campo `master:N`, vedi §4);
- `KernelVersion` di `GET /info` dell'API Docker (`backend/docker-api.ts`) contiene `truenas` → host TrueNAS; l'utente configura URL e chiave API nelle impostazioni.

Il risultato è per endpoint: ogni agent è un host diverso con la sua cartella stacks e i suoi pool. Le operazioni ZFS passano dai socket handler degli agent.

## 4. Propagazione dei mount (requisito)

Un bind mount Docker è `rprivate` di default: i dataset montati sull'host **dopo** l'avvio di Dockge non si vedono dentro Dockge, che vede la cartella vuota sottostante. Se Dockge crea il dataset `immich` e poi scrive `compose.yaml`, il file finisce nella cartella nascosta sotto il mount e il dataset sull'host resta vuoto.

La cartella stacks va montata con `rslave`:

```yaml
volumes:
  - type: bind
    source: /mnt/pool/stacks
    target: /mnt/pool/stacks
    bind:
      propagation: rslave
```

Dockge:

- all'avvio controlla in `mountinfo` che il mount sia slave (`master:N`); se no, disattiva le funzioni ZFS con un messaggio che spiega come correggere;
- dopo ogni creazione aspetta di vedere il mount (`st_dev` diverso da quello della cartella padre) prima di scriverci;
- fa eseguire le copie pesanti a un container di servizio avviato al momento (vede i mount attuali), con la stessa immagine di Dockge, come già avviene per rilevare gli IP dell'host.

## 5. Situazioni possibili

| Situazione | Come si riconosce | Cosa fa Dockge |
|---|---|---|
| `stacks` è un dataset | mountinfo: root `/` sulla cartella stacks | tutte le funzioni |
| `stacks` è una cartella dentro un dataset (es. `/mnt/pool/apps/stacks`) | mountinfo: root = sottocartella | niente creazione; avviso e procedura guidata (§5.1) |
| `stacks` non è su ZFS | statfs | UI invariata |
| `stacks` è un dataset, stack vecchi come cartelle | per stack | convivenza; conversione stack per stack (§6.3) |
| volumi su dataset di un altro albero con percorsi assoluti | bind su ZFS fuori dalla cartella dello stack | etichetta "dataset esterno", info in sola lettura, "adotta" (§6.4) |
| dataset dello stack creato prima in TrueNAS, vuoto | dataset vuoto con nome valido | lo usa per il nuovo stack invece di "Stack name already exists" |
| dataset con ACL NFSv4 + `aclmode=restricted` | proprietà del dataset | avviso (§7.2) |

### 5.1 Cartella stacks dentro un dataset

Succede a chi avvia Dockge prima di creare il dataset: Dockge (`backend/dockge-server.ts`, `initDataDir`) o Docker creano `stacks` come cartella normale. Se poi l'utente crea il dataset `stacks` da TrueNAS, copre tutti gli stack.

Dockge non può convertirla da solo (è la cartella su cui è montato e su cui girano gli stack). Offre:

- un avviso visibile: "non creare il dataset `<nome>` da TrueNAS: nasconderesti gli stack";
- uno script generato da incollare nella shell di TrueNAS: ferma gli stack e Dockge, sposta la cartella, crea il dataset con `midclt call pool.dataset.create`, ricopia, riavvia.

**Recupero dei dati nascosti.** Un container di servizio con un bind mount **non ricorsivo** del dataset padre vede il contenuto sotto i mount. Dockge può rilevare "sotto questo dataset ci sono N stack / file nascosti" e proporre il recupero. Vale per qualsiasi volume coperto per errore.

## 6. Flussi

### 6.1 Nuovo stack

Se la cartella stacks è un dataset: opzione "crea come dataset" (default dalle impostazioni). Sostituisce il `mkdir` in `Stack.save()` (`backend/stack.ts`). Se esiste già un dataset vuoto con quel nome, lo usa.

### 6.2 Prima di ogni deploy

In `Stack.deploy()` (e `start`, `update`):

1. risolve i bind con `docker compose config --format json` (percorsi assoluti, variabili sostituite), invece di interpretare lo YAML;
2. prende quelli dentro la cartella dello stack e per ognuno determina: dataset / cartella / mancante;
3. per i mancanti applica la regola (impostazione): dataset, cartella, oppure chiedi. I dataset vengono creati prima che Docker crei la cartella, con le proprietà di `x-dockge.zfs` (§8) e i permessi (§7).

Nell'editor ogni riga `./xxx` dei volumi mostra un'etichetta: "dataset", "cartella → converti", "verrà creato come dataset".

### 6.3 Convertire una cartella esistente in dataset

Con lo stack fermo (Dockge lo ferma dopo conferma):

1. snapshot di sicurezza del dataset padre;
2. `mv library library.dockge-backup-<data>` (istantaneo, stesso filesystem);
3. crea il dataset `…/immich/library`: si monta su un percorso che non esiste più, niente viene coperto;
4. copia dal backup preservando proprietario, permessi, ACL, xattr, hardlink, file sparsi (`cp -a` / `rsync -aHAX`);
5. verifica (numero di file, byte) e riavvia lo stack;
6. il backup resta finché l'utente non preme "elimina backup".

In caso di errore: distrugge il dataset e rimette il backup al suo posto. Una user property `dockge:migration=<stato>` sul dataset fa da journal: se Dockge si riavvia a metà, riprende o annulla.

**Spazio.** La copia raddoppia l'occupazione finché il backup esiste. Eccezione: block cloning (`cp --reflink`), possibile con stesso pool, `zfs_bclone_enabled=1`, niente crittografia e, secondo alcune segnalazioni, stessa recordsize. Si prova su un file di test e si ricade sulla copia normale. Prima di iniziare Dockge controlla la proprietà `available`.

Per convertire la cartella di uno stack lo schema è lo stesso; la cartella di backup va ignorata dalla scansione degli stack (`Stack.getStackList()`).

### 6.4 Adottare un dataset esistente

Per chi ha già creato i dataset dei volumi in un altro albero (es. `pool/appdata/immich/library`, montato con percorso assoluto):

- `pool.dataset.rename` → `pool/stacks/immich/library`: nello stesso pool **non copia niente**, è istantaneo; il mountpoint ereditato lo rimonta in `./library`;
- Dockge corregge il percorso nel compose con la modifica chirurgica già usata per `x-dockge.folder` (`backend/yaml-text-edit.ts`).

Condizioni e avvisi:

- stack fermo; lo stack di destinazione deve essere un dataset;
- condivisioni SMB/NFS, task di snapshot e replica che puntano al vecchio nome vanno aggiornati: Dockge li legge via API e li elenca prima;
- con la crittografia ci sono vincoli sugli spostamenti tra encryption root diverse;
- se il mountpoint del dataset è impostato esplicitamente (non ereditato) va gestito a parte.

### 6.5 Rinomina stack

`fsAsync.rename()` della cartella fallisce su un mountpoint (EBUSY). Se lo stack è un dataset: `pool.dataset.rename`; i figli seguono perché il mountpoint è ereditato.

### 6.6 Eliminazione stack

Oggi `rm -rf` della cartella: su un dataset lascerebbe i dataset vuoti o fallirebbe sui mountpoint. Il dialogo offre:

- "conserva i dataset" (default);
- "distruggi dataset e snapshot", con il nome da digitare; disponibile solo se l'impostazione che permette la distruzione è attiva.

### 6.7 Snapshot

- manuale dalla pagina dello stack (ricorsivo sul dataset dello stack);
- automatico prima di "Aggiorna", con conservazione degli ultimi N `dockge-auto-*`;
- rollback: ferma lo stack, rollback di ogni dataset, riavvia. Tornare a uno snapshot non recente distrugge quelli più nuovi: va detto chiaramente;
- "clona come nuovo stack": clone dei dataset dallo snapshot + nuovo nome;
- snapshot a stack acceso = coerente come dopo un blackout (va bene per Postgres/MySQL); opzione "ferma prima";
- gli snapshot periodici restano ai task di TrueNAS: Dockge fa solo quelli legati agli eventi.

## 7. Permessi

### 7.1 Proprietario della radice del dataset

Un dataset nuovo nasce `root:root 755` (o con le ACL del preset). Dockge **propone** il proprietario guardando, in ordine:

1. `user:` del servizio;
2. `PUID` / `PGID` nell'environment (convenzione linuxserver);
3. `User` nella configurazione dell'immagine.

Va proposto, non imposto: molte immagini (postgres, mariadb) partono da root e fanno `chown` da sole. Applicato con `filesystem.setperm` (TrueNAS) o `chown` nel container di servizio. Su TrueNAS si offrono utenti e gruppi reali (`user.query`, `group.query`). Coerente con il `chown` a `PUID`/`PGID` che `Stack.save()` già fa sulla cartella dello stack.

Con Docker in `userns-remap` gli UID sono spostati: va rilevato (`docker info`) e considerato.

### 7.2 Tipo di ACL

ACL NFSv4 con `aclmode=restricted` (tipico dei preset SMB) fa fallire `chmod` con EPERM, e molti entrypoint vanno in crash. Per i volumi: ACL POSIX (o nessuna) con i bit classici. Attenzione: in TrueNAS 25.04 il preset Apps **non** è POSIX: imposta NFSv4 con `aclmode=passthrough` e aggiunge l'utente 568 (apps) con permesso MODIFY. Dockge crea i dataset con `share_type: GENERIC`, che eredita tipo e modo delle ACL dal padre.

La soluzione pulita è configurare così `pool/stacks` una volta e far **ereditare** tutto. Dockge avvisa se trova NFSv4 + restricted.

### 7.3 Chi può fare cosa

- La chiave API di TrueNAS va legata a un utente dedicato con solo i ruoli necessari, non ad admin. Verificati sul codice di 25.04.2: `pool.dataset.query` richiede `DATASET_READ`, `pool.dataset.create` / `update` / `rename` richiedono `DATASET_WRITE` (che include `DATASET_READ`), `pool.dataset.delete` `DATASET_DELETE`, gli snapshot `SNAPSHOT_WRITE` / `SNAPSHOT_DELETE`, `filesystem.setperm` / `chown` `FILESYSTEM_ATTRS_WRITE`. Per la fase 2 basta `DATASET_WRITE`: proprietario e permessi dei dataset nuovi li applica Dockge stesso (gira come root e vede il mount).
- Login: `auth.login_ex` con `mechanism: API_KEY_PLAIN`, che richiede anche il nome dell'utente proprietario della chiave.
- TrueNAS **revoca** una chiave API usata su una connessione non sicura (né TLS, né socket Unix, né loopback): dal container di Dockge si arriva all'host via rete, quindi Dockge accetta solo `wss://`. Il certificato autofirmato di TrueNAS si accetta fissandone l'impronta SHA-256 (verificata prima di inviare la chiave).
- Dockge rifiuta lato server ogni operazione fuori dal sottoalbero del dataset della cartella stacks, anche se la chiave potrebbe di più.
- La distruzione di dataset è disattivata di default.
- La chiave di TrueNAS salvata in Dockge non esce mai da nessuna operazione, UI o API.

## 8. Fonte di verità

**ZFS dice cosa esiste.** User properties sui dataset gestiti: `dockge:managed=true`, `dockge:stack=<nome>`, `dockge:migration=<stato>`. Sopravvivono a una reinstallazione di Dockge.

**Il compose dice come crearli**, accanto a `x-dockge.folder`:

```yaml
x-dockge:
  folder: media
  zfs:
    library: { recordsize: 1M }
    pgdata:  { recordsize: 16K, owner: "999:999", mode: "0700" }
```

- Le chiavi sono percorsi relativi alla cartella dello stack. Percorsi annidati (`data/db`) richiedono che anche gli intermedi siano dataset: Dockge li crea, con un avviso.
- Al primo deploy Dockge crea i dataset con queste proprietà (utile per riprodurre lo stack altrove o dopo un ripristino del solo compose).
- Su dataset esistenti non cambia niente da solo: mostra le differenze ("recordsize in TrueNAS: 128K, nel compose: 1M").
- Docker e il Dockge originale ignorano `x-dockge`.

## 9. Selettore di percorsi dei volumi

Il selettore esistente (`PathPicker.vue`, `backend/file-browser.ts`, `DOCKGE_BROWSE_ROOTS`, `list_host_paths`) resta, con un ruolo nuovo. I volumi sono di due tipi:

1. **dati dello stack** → `./nome`;
2. **dati condivisi o esterni** (libreria media, cartelle SMB, backup, `/dev/...`) → percorso assoluto. Non devono stare dentro uno stack: eliminare o fare rollback di uno stack non deve toccarli.

La finestra ha due schede:

- **In questo stack** (default se lo stack è su ZFS): dataset e cartelle già presenti con la loro etichetta; campo "nuovo volume" con nome, preset (Generico / Database 16K / File grandi 1M) e proprietario suggerito. Inserisce `./nome:` e scrive le proprietà in `x-dockge.zfs`. Il dataset si crea al deploy, così annullare la modifica non lascia dataset orfani. Funziona anche senza ZFS, con cartelle normali.
- **Percorso dell'host**: il selettore di oggi, con l'etichetta ZFS per voce (es. "`/mnt/pool/media` → dataset `pool/media`").

Controlli sulla scelta:

- percorso assoluto dentro lo stack stesso → convertito in `./relativo` (sopravvive alla rinomina);
- dentro un altro stack → avviso: i due stack restano legati, un rollback dell'altro lo modifica;
- dataset esterno usato solo da questo stack → propone "sposta nello stack come `./nome`" (§6.4);
- radice della cartella stacks o cartella dati di Dockge → avviso o blocco.

Sorgente dei dati: con l'API di TrueNAS configurata, `pool.dataset.query` e `filesystem.listdir`, senza bisogno di montare `/mnt:/mnt:ro` e sempre aggiornata. Altrimenti il mount di oggi, da fare con `rslave`.

## 10. API e MCP

Le operazioni sono definite una sola volta in `backend/api/operations.ts` ed esposte come REST, MCP e OpenAPI. UI e API chiamano lo stesso codice. Come le API attuali, lavorano sul Dockge locale (nessun parametro `endpoint`); quando le API arriveranno agli agent, il parametro andrà aggiunto per tutte insieme.

### 10.1 Nuove operazioni (tag "Storage")

| Operazione | Percorso | Permesso | Note |
|---|---|---|---|
| `get_storage_status` | `GET /storage` | read | ZFS sì/no, provider, dataset della cartella stacks, propagazione, ACL, block cloning, problemi con il rimedio. Riassunto anche in `get_info` |
| `get_stack_storage` | `GET /stacks/:name/storage` | read | stack dataset sì/no; per ogni bind: servizi, tipo (dataset / cartella / mancante / esterno / non ZFS), spazio, proprietà, proprietario, differenze con `x-dockge.zfs`, migrazioni in corso |
| `list_snapshots` | `GET /stacks/:name/snapshots` | read | |
| `list_jobs`, `get_job` | `GET /jobs`, `GET /jobs/:id` | read | passo, percentuale, byte copiati, log |
| `create_volume_dataset` | `POST /stacks/:name/storage/volumes` | write | crea `./xxx` come dataset; se la cartella esiste serve `migrate: true` (job) |
| `convert_stack_to_dataset` | `POST /stacks/:name/storage/convert` | write | job |
| `adopt_dataset` | `POST /stacks/:name/storage/adopt` | write | `dataset`, `path`; corregge il compose |
| `set_volume_permissions` | `PUT /stacks/:name/storage/permissions` | write | uid, gid, mode, ricorsivo |
| `set_dataset_properties` | `PUT /stacks/:name/storage/properties` | write | solo una lista di proprietà ammesse (recordsize, compression, atime, quota, …) |
| `create_snapshot` | `POST /stacks/:name/snapshots` | write | `label`, `stopFirst` |
| `clone_stack` | `POST /stacks/:name/snapshots/:snapshot/clone` | write | `newName` |
| `rollback_snapshot` | `POST /stacks/:name/snapshots/:snapshot/rollback` | write, distruttiva | |
| `delete_snapshot` | `DELETE /stacks/:name/snapshots/:snapshot` | write, distruttiva | |
| `delete_migration_backup` | `DELETE /stacks/:name/storage/backups/:id` | write, distruttiva | |
| `cancel_job` | `POST /jobs/:id/cancel` | write | |

### 10.2 Operazioni esistenti che cambiano

- `create_stack`: `dataset` (default dalle impostazioni); usa un dataset vuoto già esistente con quel nome.
- `deploy_stack`, `start_stack`, `update_stack`: `missingVolumes: "dataset" | "directory" | "fail"`. Via API non si può chiedere: se l'impostazione è "chiedi", il default API è `fail` con l'elenco di cosa manca. Nessuna cartella creata in silenzio.
- `update_stack`: `snapshot` (default dall'impostazione dello snapshot automatico).
- `delete_stack`: `datasets: "keep" | "destroy"`, default `keep`.
- `rename_stack`: nessun parametro nuovo, usa la rinomina del dataset.
- `list_host_paths`: ogni voce aggiunge `dataset` e `stack` (a quale stack appartiene, se appartiene a uno).

### 10.3 Regole trasversali

- **`dryRun`** su ogni scrittura: restituisce il piano (passi, servizi che verranno fermati, spazio necessario, backup che resteranno) senza toccare niente.
- **Job** per le operazioni lunghe: rispondono subito con `jobId`; gli stessi job sono visibili nella UI.
- **Blocco per stack**: durante una migrazione, deploy / stop / rinomina dello stesso stack vengono rifiutati, da API e da UI.
- **Operazioni distruttive** (distruzione dataset, rollback, cancellazione di snapshot e backup): chiave `write` + impostazione "operazioni ZFS distruttive via API" (spenta di default) + `confirm` uguale al nome esatto del bersaglio, non `true`. In MCP sono marcate `destructive`.
- **Testi per l'AI**: le istruzioni MCP (`backend/api/api-router.ts`, `MCP_INSTRUCTIONS`) e la descrizione di `create_stack` oggi consigliano i percorsi assoluti: vanno invertiti. `./nome` per i dati dello stack, `list_host_paths` solo per dati condivisi o esterni, `dryRun` prima delle scritture.

## 11. Impostazioni

| Impostazione | Default |
|---|---|
| Funzioni ZFS | automatico (attive se rilevate e se la propagazione è corretta) |
| Provider | TrueNAS se rilevato |
| URL e chiave API di TrueNAS | – |
| Nuovi stack come dataset | sì |
| Volumi `./xxx` mancanti | chiedi |
| Proprietà predefinite per i nuovi dataset | ereditate |
| Snapshot automatico prima di "Aggiorna" | sì, conserva gli ultimi 5 |
| Distruzione di dataset dalla UI | no |
| Operazioni ZFS distruttive via API | no |

## 12. Punti del codice coinvolti

- `backend/stack.ts`: `save()` (mkdir → dataset), `deploy()` / `start()` / `update()` (controllo dei volumi), `rename()` (rinomina dataset), `delete()` (conserva / distruggi), `getStackList()` (ignora cartelle di backup e temporanee).
- `backend/dockge-server.ts`: `initDataDir()` (rilevamento e avvisi all'avvio).
- `backend/docker-api.ts`: `GET /info` per riconoscere TrueNAS; ispezione immagini per `User`.
- `backend/file-browser.ts`, `frontend/src/components/PathPicker.vue`, `ArrayInput.vue`: selettore (§9).
- `frontend/src/components/Container.vue`: etichette sui volumi.
- `backend/agent-socket-handlers/`: operazioni per endpoint.
- `backend/api/operations.ts`, `backend/api/api-router.ts`: §10.
- nuovo `backend/zfs/`: rilevamento, `ZfsProvider` e implementazioni, job, journal delle migrazioni.

## 13. Fasi

1. **Rilevamento e sola lettura**: stato ZFS e propagazione, avvisi (§5), etichette sui volumi nell'editor e nel selettore, `get_storage_status` / `get_stack_storage`, inversione dei testi API/MCP. **Fatta** (`backend/zfs/`, Impostazioni → Archiviazione). Rimandati alla fase 2 perché richiedono le proprietà dei dataset, quindi il provider: avviso ACL NFSv4 + `aclmode=restricted`, proprietà e differenze con `x-dockge.zfs`, dataset vuoto usato per un nuovo stack.
2. **Creazione**: provider TrueNAS, nuovi stack come dataset, volumi creati prima del deploy con proprietà e permessi, scheda "In questo stack", selettore alimentato dall'API di TrueNAS. Nel selettore, il badge "stack X" va mostrato solo se la cartella contiene un compose; il selettore deve sapere da quale stack è aperto: per le cartelle di quello stack il badge diventa "questo stack" e il percorso scelto viene inserito come `./nome`.
   **Fatto**: client JSON-RPC (`backend/zfs/truenas-client.ts`, solo `wss://`, impronta del certificato), impostazioni per endpoint, nuovi stack come dataset (anche riusando un dataset vuoto creato prima), controllo dei volumi mancanti prima di deploy / avvio / aggiorna con la regola chiedi / dataset / cartella e il dialogo, `x-dockge.zfs` (recordsize, compression, atime, quota, owner, mode) con le differenze mostrate nell'editor, proprietario suggerito da `user:` / `PUID` / immagine, avvisi su ACL restricted e su mountpoint diverso, badge del selettore, `create_volume_dataset` e `dryRun` nelle API.
   Nel frattempo, rinomina ed eliminazione di uno stack che contiene dataset vengono rifiutate (l'eliminazione rimuove i container e conserva i dati) fino alla fase 4.
   Completata con: avviso al deploy per i bind dentro **un altro stack** (dialogo nell'interfaccia, chiesto una volta per percorso; `warnings` nelle API), scheda "In questo stack" del selettore (cartelle e dataset dello stack, nuovo volume con tipo Generico / Database 16K / File grandi 1M e proprietario, scritto in `x-dockge.zfs`), selettore che legge l'host da `filesystem.listdir` quando l'utente TrueNAS ha anche `FILESYSTEM_ATTRS_READ` (altrimenti le cartelle montate in Dockge), `set_dataset_properties` (via `pool.dataset.update`) e `set_volume_permissions` (eseguito da Dockge, ricorsivo solo per il proprietario e senza entrare nei dataset figli), clic sul badge `≠ x-dockge.zfs` per applicare i valori al dataset, avviso per `userns-remap` (gli UID non vengono tradotti).
3. **Snapshot**: manuali, automatici prima di "Aggiorna", rollback, clone.
   **Fatto** (`backend/zfs/snapshots.ts`, riquadro "Snapshot" nella pagina dello stack): snapshot ricorsivi `dockge-<data>[-etichetta]` con opzione "ferma i container", `dockge-auto-<data>` prima di "Aggiorna" (dopo il pull, prima di ricreare i container; se fallisce l'aggiornamento non viene fatto) con conservazione degli ultimi N, elenco che include gli snapshot dei task di TrueNAS, rollback (ferma, `zfs.snapshot.rollback` con `recursive` e `recursive_rollback`, riavvia con `docker compose start`; distrugge gli snapshot più nuovi, elencati prima), clone come nuovo stack (cloni di ogni dataset, percorsi assoluti riscritti, non avviato), eliminazione. Nella UI rollback ed eliminazione si confermano scrivendo il nome; nelle API servono l'impostazione "operazioni distruttive via API" e `confirm` uguale al nome.
   Connessione: Dockge tiene aperta una sola connessione autenticata e la riusa (chiusa dopo 60 s senza chiamate). TrueNAS limita a 20 al minuto per IP le chiamate fatte prima del login (`auth.login_ex`), e un login per ogni operazione portava a `[EBUSY] Rate Limit Exceeded`.
   **Limite di TrueNAS 25.04**: in 25.04 i metodi sono `zfs.snapshot.*` (non `pool.snapshot.*`). `create` / `query` richiedono `SNAPSHOT_WRITE` / `SNAPSHOT_READ`, `delete` `SNAPSHOT_DELETE`, ma `rollback` e `clone` non hanno ruoli: li può chiamare solo un amministratore completo. Con una chiave limitata Dockge rifiuta con un messaggio che spiega come farli da TrueNAS.
4. **Migrazioni**: conversione guidata di cartelle e stack esistenti, adozione di dataset esterni, rinomina ed eliminazione consapevoli dei dataset, procedura per la cartella stacks (§5.1), recupero di dati nascosti.
   **Fatto** (`backend/zfs/migrate.ts`, `adopt.ts`, `hidden.ts`, `scripts.ts`, `jobs.ts`; riquadro "Archiviazione" nella pagina dello stack):
   - eliminazione di uno stack che è un dataset, con la scelta "elimina anche i dataset" (elenco dei dataset e numero di snapshot, conferma con il nome; `pool.dataset.delete` ricorsivo, ruolo `DATASET_DELETE`; la cartella viene rimossa solo quando i dataset non sono più montati) oppure "conserva i dati";
   - rinomina di uno stack che è un dataset (`zfs.dataset.rename`, i figli seguono);
   - conversione in dataset di una cartella `./volume` o della cartella dello stack, come job con avanzamento: stop, snapshot di sicurezza, `mv` in `<nome>.dockge-backup-<data>`, creazione del dataset, `cp -a --reflink=auto`, verifica (numero di file e cartelle, byte), riavvio; in caso di errore il dataset viene distrutto e la cartella rimessa al suo posto; `dockge:migration=copying` segnala una conversione interrotta, che si può annullare; le copie restano finché l'utente non le elimina e sono escluse dall'elenco degli stack; durante un job deploy / avvio / stop / rinomina / eliminazione dello stack sono rifiutati;
   - adozione di un dataset esterno (stesso pool) come `./nome`, con riscrittura dei percorsi nel compose; condivisioni e task di TrueNAS (`pool.dataset.attachments`) e altri stack che lo usano vengono elencati prima; se Dockge non vede il percorso, TrueNAS dice di quale dataset è il mountpoint;
   - script per TrueNAS che sposta la cartella stacks in un dataset (§5.1), solo se è direttamente dentro il dataset padre;
   - ricerca e recupero dei dati nascosti sotto i mount con un container di servizio e bind non ricorsivi (`bind-recursive=disabled`, Docker 25+): il contenuto viene spostato in `<nome>.dockge-hidden-<data>` accanto al mount.
   **Limite di TrueNAS 25.04**: non esiste `pool.dataset.rename`; `zfs.dataset.rename` (usato per rinomina e adozione) non ha ruoli, come rollback e clone: serve la chiave di un amministratore completo.
   **Non provato senza Docker reale**: la ricerca dei dati nascosti (ho provato la logica del container su una struttura simulata, non l'avvio del container).

Poi, eventualmente: provider ZFS generico (`nsenter`).

## Decisioni prese

- Si parte solo da TrueNAS (API); il provider generico viene dopo.
- Stack come dataset: a scelta per stack, default sì.
- Volumi `./xxx` mancanti: default "chiedi" (impostazione), via API parametro esplicito.
- Il selettore di percorsi resta, con le due schede (§9).
