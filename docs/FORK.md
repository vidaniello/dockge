# Dockge – fork vidaniello

Questo fork aggiunge a Dockge:

- terminali con copia/incolla funzionante anche su HTTP, ridimensionabili e a schermo intero;
- editor `compose.yaml` / `.env` a schermo intero, log separati per servizio;
- barra laterale ridimensionabile e richiudibile, cartelle virtuali, gruppo "Stack non gestiti" (con le app TrueNAS a parte);
- rinomina degli stack, selettore di cartelle dell'host per i volumi, menu degli IP dell'host per le porte;
- avvisi sulle immagini aggiornabili;
- API REST + endpoint MCP per script e assistenti AI, con chiavi API.

L'immagine è pubblicata da GitHub Actions su `ghcr.io/vidaniello/dockge` (tag `latest` da `master`, `1.2.3` dai tag `v1.2.3`).

## Variabili d'ambiente aggiunte

| Variabile | Default | A cosa serve |
|---|---|---|
| `DOCKGE_BROWSE_ROOTS` | `/mnt` | Cartelle (separate da virgola) che il selettore di percorsi può sfogliare, in sola lettura. Vanno montate nel container **con lo stesso percorso** a sinistra e a destra. |
| `DOCKGE_HOST_IPS` | rilevati | IP dell'host da proporre nel menu delle porte (separati da virgola). Se non impostata, Dockge li rileva avviando per un istante la propria immagine con `--network host`. |
| `DOCKGE_API_PORT` | – | Porta dedicata per API e MCP. Se impostata, la porta principale **non** risponde più su `/api` e `/mcp`. |
| `DOCKGE_API_HOSTNAME` | tutti | IP su cui ascolta la porta API (dentro il container). |
| `DOCKGE_API_SSL_KEY` / `DOCKGE_API_SSL_CERT` / `DOCKGE_API_SSL_KEY_PASSPHRASE` | quelli di `DOCKGE_SSL_*` | Certificato TLS della porta API. |
| `DOCKGE_TRUST_PROXY` | – | Reverse proxy fidati (`true`, numero di salti, oppure IP/subnet separati da virgola, es. `loopback,192.168.1.2`). Dockge si fida di `X-Forwarded-Proto: https` solo da questi. |
| `DOCKGE_API_ALLOW_HTTP` | `false` | `true` accetta le chiavi anche su HTTP. Sconsigliato: la chiave viaggia in chiaro. |

## Esempio: TrueNAS SCALE

```yaml
services:
  dockge:
    image: ghcr.io/vidaniello/dockge:latest
    restart: unless-stopped
    ports:
      # Interfaccia web, solo sull'IP di gestione
      - 192.168.1.10:5001:5001
      # API / MCP (HTTPS), solo su questo IP
      - 192.168.1.10:5002:5002
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - /mnt/pool/apps/dockge/data:/app/data
      - /mnt/pool/apps/dockge/certs:/certs:ro
      # Stacks: stesso percorso a sinistra e a destra
      - /mnt/pool/stacks:/mnt/pool/stacks
      # Selettore di percorsi dei volumi (sola lettura), stesso percorso
      - /mnt:/mnt:ro
    environment:
      - DOCKGE_STACKS_DIR=/mnt/pool/stacks
      - DOCKGE_BROWSE_ROOTS=/mnt
      - DOCKGE_API_PORT=5002
      - DOCKGE_API_SSL_KEY=/certs/key.pem
      - DOCKGE_API_SSL_CERT=/certs/cert.pem
```

**Su quale IP ascolta?** Con la rete bridge di Docker (il caso normale) il container non vede gli IP dell'host: l'IP si sceglie nella mappatura delle porte, come sopra (`IP_HOST:PORTA_HOST:PORTA_CONTAINER`). `DOCKGE_API_HOSTNAME` serve solo con `network_mode: host` o fuori da Docker.

## API

- REST: `https://<host>:<porta>/api/v1/...`
- Descrizione completa (OpenAPI 3.1, senza chiave): `/api/v1/openapi.json`
- MCP (Streamable HTTP, risposte JSON): `/mcp`

Le chiavi si creano in **Impostazioni → Chiavi API** (serve la password). Si mandano con `Authorization: Bearer dk_...` oppure `X-API-Key: dk_...`.

- **Sola lettura**: elenco e dettaglio degli stack, log, aggiornamenti immagini, cartelle e IP dell'host, reti.
- **Controllo completo**: in più crea / modifica / elimina stack, deploy, start, stop, restart, down, update, rinomina, cartelle, start/stop/restart dei servizi ed **esecuzione di comandi nei container** (`exec_in_service`). Equivale all'accesso root all'host.

Le richieste HTTP vengono rifiutate: serve il TLS di Dockge (`DOCKGE_SSL_*` o `DOCKGE_API_SSL_*`) oppure un reverse proxy HTTPS indicato in `DOCKGE_TRUST_PROXY`. Dopo 10 tentativi falliti in un minuto un IP viene bloccato per un minuto.

Esempi:

```bash
curl -H "Authorization: Bearer $DOCKGE_KEY" https://192.168.1.10:5002/api/v1/stacks
curl -H "Authorization: Bearer $DOCKGE_KEY" "https://192.168.1.10:5002/api/v1/stacks/web/logs?service=app&tail=100"
curl -X POST -H "Authorization: Bearer $DOCKGE_KEY" -H "Content-Type: application/json" \
     -d '{"command": "ls -la /config"}' https://192.168.1.10:5002/api/v1/stacks/web/services/app/exec
```

### Collegare un assistente AI (MCP)

Configurazione per un client MCP che supporta i server HTTP (es. Claude Code: `claude mcp add --transport http dockge https://192.168.1.10:5002/mcp --header "Authorization: Bearer dk_..."`):

```json
{
  "mcpServers": {
    "dockge": {
      "type": "http",
      "url": "https://192.168.1.10:5002/mcp",
      "headers": { "Authorization": "Bearer dk_..." }
    }
  }
}
```

Con una chiave in sola lettura l'assistente vede solo gli strumenti di lettura. Con un certificato autofirmato il client deve fidarsi del certificato (o usa un reverse proxy con un certificato valido).

## Compatibilità con una installazione Dockge esistente

- **Cartella `data`**: all'avvio viene aggiunta la tabella `api_key` e alcune impostazioni (`imageUpdate*`). Si può tornare all'immagine originale: Dockge segnala la migrazione sconosciuta come avviso e parte normalmente.
- **Cartella degli stack**: i file non vengono toccati finché non li modifichi. Le cartelle virtuali aggiungono `x-dockge: folder: ...` al compose: Docker e il Dockge originale lo ignorano. La rinomina può aggiungere `name:` ai volumi con nome.
- **`.env`**: questo fork salva davvero il `.env` modificato dall'interfaccia (nel codice di partenza veniva perso).
- Prima di cambiare immagine conviene comunque fare una copia di `data/dockge.db`.
