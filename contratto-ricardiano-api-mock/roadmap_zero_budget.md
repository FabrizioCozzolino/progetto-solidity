# Roadmap Conformità — Versione Budget Zero
## RicardianForestTracking

**Filosofia.** Tutto quello che si può fare senza spendere un euro, fatto in ordine logico di dipendenze. Le voci a pagamento sono raccolte in una sezione finale come "decisioni di budget" da portare al capo.

**Effort stimato.** ~1 dev senior, ~10-12 settimane part-time o ~6-8 settimane full-time.

**Cosa otterrai gratis.** Conformità sostanziale a:
- Art. 41 Reg. (UE) 910/2014 (validazione temporale non qualificata) ✅
- Art. 8-ter c.1 e c.3 L. 12/2019 (DLT e validazione temporale) ✅
- Verifica indipendente CAdES contro EU LOTL ✅ (riconoscimento FEQ se l'utente firma con QTSP)
- GDPR baseline documentale ✅
- Hardening sicurezza P0 ✅

**Cosa NON otterrai senza budget.**
- Identificazione informatica delle parti via SPID (richiede ~50€/mese hub OR registrazione SP) → impatta art. 8-ter c.2
- Marche temporali qualificate generate dal server (CAdES-T proprietario)
- Status QTSP, conservazione a norma, certificazioni ISO

---

## Step 1 — Quick wins immediati (1-2 ore di lavoro)

**Goal.** Rimuovere il 60% del rischio bloccante in mezza giornata.

### 1.1 Rimuovi la chiave Hardhat hardcoded

**File.** `server_registerRicardianForest.js`, riga ~47

**Da:**
```js
const PRIVATE_KEY =
  process.env.PRIVATE_KEY ||
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
```

**A:**
```js
const PRIVATE_KEY = process.env.PRIVATE_KEY;
if (!PRIVATE_KEY) {
  console.error("[FATAL] PRIVATE_KEY non impostata. Server non avviato.");
  process.exit(1);
}
if (PRIVATE_KEY === "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80") {
  console.error("[FATAL] PRIVATE_KEY è la chiave Hardhat di default. Inammissibile.");
  process.exit(1);
}
```

### 1.2 Attiva la verifica TLS verso TopView

**File.** `server_registerRicardianForest.js`, riga ~35

**Da:**
```js
const TOPVIEW_HTTPS_INSECURE = (process.env.TOPVIEW_HTTPS_INSECURE || "true") === "true";
```

**A:**
```js
const TOPVIEW_HTTPS_INSECURE = (process.env.TOPVIEW_HTTPS_INSECURE || "false") === "true";
if (TOPVIEW_HTTPS_INSECURE) {
  console.warn("[WARN] TLS verification verso TopView DISABILITATA. Solo per dev locale.");
}
```

### 1.3 Rimuovi password di default

**File.** `server_registerRicardianForest.js`, righe ~33-34

**Da:**
```js
const TOPVIEW_USERNAME = process.env.TOPVIEW_USERNAME || "operator";
const TOPVIEW_PASSWORD = process.env.TOPVIEW_PASSWORD || "1234567!";
```

**A:**
```js
const TOPVIEW_USERNAME = process.env.TOPVIEW_USERNAME;
const TOPVIEW_PASSWORD = process.env.TOPVIEW_PASSWORD;
if (!TOPVIEW_USERNAME || !TOPVIEW_PASSWORD) {
  console.error("[FATAL] Credenziali TopView mancanti.");
  process.exit(1);
}
```

### 1.4 Sposta RPC default a una rete pubblica

**File.** `server_registerRicardianForest.js`, riga ~46

**Da:**
```js
const RPC_URL = process.env.RPC_URL || "http://127.0.0.1:8545";
```

**A:**
```js
const RPC_URL = process.env.RPC_URL;
if (!RPC_URL) {
  console.error("[FATAL] RPC_URL non impostata. Suggerito: Sepolia o Polygon Amoy per test.");
  process.exit(1);
}
console.log("[INFO] RPC target:", RPC_URL.replace(/\/\/.*@/, "//***@")); // mask credentials
```

Esempi di RPC gratuiti per testnet:
- Sepolia: `https://ethereum-sepolia.publicnode.com` (gratis, public RPC)
- Polygon Amoy: `https://rpc-amoy.polygon.technology` (gratis)
- Per produzione futura, valuta provider gratuiti tier free: Alchemy, Infura, QuickNode (tutti hanno tier free generosi)

### 1.5 Crea un file `.env.example`

Documenta tutte le env var richieste senza esporre i valori reali. Aggiungilo al repo, mai il `.env` reale.

```bash
# .env.example - copiare in .env e compilare
PORT=3000
PRIVATE_KEY=  # OBBLIGATORIO: chiave Ethereum del server (NEVER commit)
RPC_URL=  # OBBLIGATORIO: es. https://ethereum-sepolia.publicnode.com
TOPVIEW_USERNAME=  # OBBLIGATORIO
TOPVIEW_PASSWORD=  # OBBLIGATORIO
TOPVIEW_HTTPS_INSECURE=false  # SEMPRE false in prod
TOPVIEW_TOKEN_URL=https://digimedfor.topview.it/api/get-token/
TOPVIEW_FOREST_UNITS_URL=https://digimedfor.topview.it/api/get-forest-units/
IPFS_URL=http://127.0.0.1:5004/api/v0
RICARDIAN_DIR=./storage/ricardians
CADES_DIR=./storage/cades
TMP_DIR=./storage/tmp
```

### 1.6 Aggiungi `.env` al `.gitignore`

```bash
echo ".env" >> .gitignore
echo "environment_variables.env" >> .gitignore
git rm --cached .env environment_variables.env 2>/dev/null || true
```

### 1.7 Verifica e commit

```bash
node -e "require('./server_registerRicardianForest.js')"
# deve fallire con messaggio chiaro se manca una env var
git add -A && git commit -m "security: rimuovi default insicuri, force fail-fast su env var mancanti"
```

**Tempo totale**: 1-2 ore. **Costo**: 0€.

---

## Step 2 — Deploy ricardianBase v3.0 (mezza giornata)

**Goal.** Allineare le dichiarazioni legali alla realtà tecnica.

### 2.1 Sostituisci il `ricardianBase` originale

Apri `server_registerRicardianForest.js`, vai alla funzione `buildAndSignRicardianInternal` (riga ~626), e sostituisci tutto il blocco `const ricardianBase = { ... }` (righe ~631-779) con il contenuto del file `ricardianBase_v3.js` che ti ho fornito (la sola parte dell'oggetto, non l'intero modulo).

### 2.2 Aggiungi il check di identificazione del Sottoscrittore

Subito dopo la dichiarazione di `ricardianBase`, prima di `toKeccak256Json(ricardianBase)`:

```js
function assertSubscriberIdentified(ricardianBase) {
  const sub = ricardianBase?.parties?.subscriber;
  if (!sub?.legalEntity) {
    throw new Error(
      "Subscriber non identificato: art. 8-ter c.2 L. 12/2019 richiede " +
      "identificazione informatica delle parti prima della firma. " +
      "Popolare parties.subscriber.legalEntity prima di chiamare buildAndSign."
    );
  }
}

// poi, prima di toKeccak256Json:
assertSubscriberIdentified(ricardianBase);
```

Per ora, nel chiamante upstream di `buildAndSignRicardianInternal`, popola manualmente `parties.subscriber` con i dati contrattuali del cliente reale (P.IVA, ragione sociale). Questo non soddisfa l'art. 8-ter c.2 in senso stretto (manca SPID), ma documenta esplicitamente chi è il sottoscrittore. SPID arriverà nello Step 6 (richiede budget).

### 2.3 Aggiorna il PDF generator

La funzione `generateRicardianPdf` deve riflettere la nuova struttura. Apri il PDF generator (probabilmente in un file separato non visto) e adatta i campi: `legal.timeStampValidation.basis`, `legal.documentSignature`, `disclaimers`, `verificationProcedure`. Mantieni la leggibilità.

### 2.4 Test smoke

Genera un nuovo ricardiano di test con il flusso esistente e verifica:
- Il JSON contiene la nuova struttura
- L'hash è diverso dai precedenti (atteso: è una breaking change)
- Il PDF si genera correttamente
- L'ancoraggio on-chain funziona

**Tempo totale**: 4-6 ore. **Costo**: 0€.

---

## Step 3 — Logging e auditabilità (1 giornata)

**Goal.** Avere log strutturati e tracciabili per audit e debugging.

### 3.1 Installa `pino`

```bash
npm install pino pino-pretty
```

### 3.2 Crea un modulo logger centralizzato

Nuovo file `lib/logger.js`:

```js
const pino = require("pino");

const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  redact: {
    paths: [
      "*.PRIVATE_KEY",
      "*.privateKey",
      "*.password",
      "*.PASSWORD",
      "headers.authorization",
      "headers.cookie",
      "*.token"
    ],
    censor: "[REDACTED]"
  },
  transport: process.env.NODE_ENV === "production"
    ? undefined
    : { target: "pino-pretty", options: { colorize: true } }
});

module.exports = logger;
```

### 3.3 Sostituisci `console.log/error/warn`

In tutto il file principale, sostituisci progressivamente:
```js
console.log("[CHAIN] signer:", addr);
// →
logger.info({ chainId, signer: addr, balance: ... }, "Chain ready");
```

### 3.4 Correlation ID per richiesta

Middleware che assegna un ID a ogni request:

```js
const { randomUUID } = require("crypto");

app.use((req, res, next) => {
  req.requestId = req.headers["x-request-id"] || randomUUID();
  res.setHeader("X-Request-ID", req.requestId);
  req.log = logger.child({ requestId: req.requestId });
  next();
});
```

### 3.5 Audit log per operazioni critiche

Per ogni `register`, `setPdfUri`, `registerCountersignature`, log strutturato:

```js
req.log.info({
  op: "registerRicardianForest",
  forestUnitId,
  ricardianHash,
  merkleRoot,
  txHash: receipt.transactionHash,
  signerAddress
}, "Ricardiano ancorato on-chain");
```

**Tempo totale**: 4-6 ore. **Costo**: 0€.

---

## Step 4 — Rate limiting e auth minimale (1 giornata)

**Goal.** Proteggere gli endpoint di scrittura.

### 4.1 Rate limiting

```bash
npm install express-rate-limit
```

```js
const rateLimit = require("express-rate-limit");

const writeLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minuto
  max: 10,             // max 10 richieste/min per IP
  message: { error: "Troppe richieste, riprova tra un minuto" }
});

app.use("/api/contract/write", writeLimiter);
app.use("/api/contract/write2", writeLimiter);
```

### 4.2 API key minimale

Genera una API key forte (256 bit) e mettila in env:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# salva il risultato in API_KEY env var
```

Middleware:

```js
const API_KEY = process.env.API_KEY;
if (!API_KEY || API_KEY.length < 32) {
  console.error("[FATAL] API_KEY mancante o troppo debole");
  process.exit(1);
}

function requireApiKey(req, res, next) {
  const provided = req.headers["x-api-key"];
  if (!provided || provided !== API_KEY) {
    return res.status(401).json({ error: "API key invalid or missing" });
  }
  next();
}

// applica solo agli endpoint di scrittura
app.use("/api/contract/write", requireApiKey);
app.use("/api/contract/write2", requireApiKey);
```

Questa è auth minimale — sufficiente per uso interno o B2B con un singolo cliente. Per multi-tenant servirà JWT con scopes (Step futuro).

### 4.3 CORS più restrittivo

Sostituisci `app.use(cors())` con whitelist:

```js
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "").split(",").filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error("CORS: origin not allowed"));
  }
}));
```

**Tempo totale**: 3-5 ore. **Costo**: 0€.

---

## Step 5 — DSS validator (1-2 giorni)

**Goal.** Sostituire OpenSSL `-noverify` con vera validazione contro EU LOTL. Questo è il pezzo più importante: trasforma `validOffchain` da bugia a verità.

### 5.1 Setup container DSS

DSS è un'app Java open source della Commissione UE. Funziona standalone via Docker:

```bash
mkdir -p dss-service
cd dss-service
cat > docker-compose.yml << 'EOF'
version: "3.8"
services:
  dss:
    image: esig/dss-demo-webapp:6.1
    ports:
      - "127.0.0.1:8090:8080"
    environment:
      - LOTL_CACHE_DIR=/dss-cache
    volumes:
      - dss-cache:/dss-cache
    restart: unless-stopped

volumes:
  dss-cache:
EOF

docker compose up -d
```

Verifica che funzioni: `curl http://127.0.0.1:8090/services/rest` deve rispondere.

L'immagine `esig/dss-demo-webapp` è quella ufficiale, hostata da ESIG (European Signature Initiative Group, gestione DSS della Commissione UE).

### 5.2 Wrapper Node.js per DSS

Nuovo file `lib/dssClient.js`:

```js
const axios = require("axios");
const fs = require("fs");

const DSS_URL = process.env.DSS_URL || "http://127.0.0.1:8090/services/rest";

async function validateCades(p7mPath) {
  const fileBytes = fs.readFileSync(p7mPath).toString("base64");

  const payload = {
    signedDocument: {
      bytes: fileBytes,
      digestAlgorithm: null,
      name: "signed.p7m"
    },
    originalDocuments: [],
    policy: null,
    signatureId: null
  };

  try {
    const res = await axios.post(`${DSS_URL}/validation/validateSignature`, payload, {
      timeout: 30000,
      headers: { "Content-Type": "application/json" }
    });

    const report = res.data;

    return {
      ok: true,
      signatureLevel: extractSignatureLevel(report),
      indication: extractIndication(report),
      qcCompliance: extractQcCompliance(report),
      qcSSCD: extractQcSSCD(report),
      certificateChain: extractChain(report),
      revocationStatus: extractRevocation(report),
      timestampPresent: extractTimestamp(report),
      rawReport: report
    };
  } catch (err) {
    return {
      ok: false,
      error: err.message,
      rawError: err.response?.data
    };
  }
}

function extractSignatureLevel(report) {
  // valori possibili: QESig, QESeal, AdESig-QC, AdESeal-QC, AdESig, AdESeal, NA
  return report?.SimpleReport?.signature?.[0]?.SignatureLevel?.value || "UNKNOWN";
}

function extractIndication(report) {
  // valori: TOTAL_PASSED, TOTAL_FAILED, INDETERMINATE
  return report?.SimpleReport?.signature?.[0]?.Indication || "UNKNOWN";
}

function extractQcCompliance(report) {
  const sig = report?.DetailedReport?.Signatures?.[0];
  return sig?.ValidationCertificateQualification?.[0]?.SubXCV?.[0]?.Conclusion?.Indication === "PASSED";
}

function extractQcSSCD(report) {
  // Helper più semplificato; nella pratica DSS espone QCStatements parsing dettagliato
  const sig = report?.DetailedReport?.Signatures?.[0];
  return !!sig?.ValidationCertificateQualification?.find(q => q?.QCStatement?.QcSSCD);
}

function extractChain(report) {
  return report?.DiagnosticData?.Certificate?.map(c => ({
    subject: c.SubjectDistinguishedName,
    issuer: c.IssuerDistinguishedName,
    notBefore: c.NotBefore,
    notAfter: c.NotAfter,
    trusted: c.Trusted
  })) || [];
}

function extractRevocation(report) {
  const certs = report?.DiagnosticData?.Certificate || [];
  return certs.map(c => ({
    subject: c.SubjectDistinguishedName,
    revocationStatus: c.Revocation?.[0]?.Status || "UNKNOWN"
  }));
}

function extractTimestamp(report) {
  return (report?.DiagnosticData?.Timestamp || []).length > 0;
}

module.exports = { validateCades };
```

> Nota: l'esatta forma delle chiamate REST DSS varia per versione. Consulta la documentazione `https://ec.europa.eu/digital-building-blocks/DSS/webapp-demo/` o il README della demo image. La logica sopra è il pattern, non un copy-paste garantito al 100% — la prima esecuzione richiederà un fine-tuning dei path JSON in base alla risposta reale.

### 5.3 Sostituisci `verifyAndExtractCadesAttachedPdf`

Nel server principale, sostituisci la funzione esistente con:

```js
const { validateCades } = require("./lib/dssClient");

async function verifyAndExtractCadesAttachedPdf(p7mPath, extractedPdfPath) {
  // 1) Validazione DSS contro EU LOTL
  const dssResult = await validateCades(p7mPath);

  // 2) Estrazione del PDF originale (per verifica integrità)
  // OpenSSL serve ancora per estrarre il payload, ma NON per validare la firma
  const extractAttempts = [
    ["cms", "-verify", "-inform", "DER", "-binary", "-noverify", "-in", p7mPath, "-out", extractedPdfPath],
    ["smime", "-verify", "-inform", "DER", "-binary", "-noverify", "-in", p7mPath, "-out", extractedPdfPath]
  ];

  let extractOk = false;
  let extractError = null;
  for (const args of extractAttempts) {
    try {
      await execFileAsync("openssl", args);
      extractOk = true;
      break;
    } catch (err) {
      extractError = err;
    }
  }

  if (!extractOk) {
    return {
      ok: false,
      error: "Estrazione PDF dal CAdES fallita",
      extractError: extractError?.message,
      dssResult
    };
  }

  // 3) Determina validOffchain in base al risultato DSS
  const validOffchain =
    dssResult.ok &&
    dssResult.indication === "TOTAL_PASSED" &&
    ["QESig", "AdESig-QC"].includes(dssResult.signatureLevel);

  return {
    ok: true,
    extractOk: true,
    validOffchain,
    signatureLevel: dssResult.signatureLevel,
    indication: dssResult.indication,
    qcCompliance: dssResult.qcCompliance,
    qcSSCD: dssResult.qcSSCD,
    certificateChain: dssResult.certificateChain,
    revocationStatus: dssResult.revocationStatus,
    timestampPresent: dssResult.timestampPresent,
    dssReport: dssResult.rawReport
  };
}
```

### 5.4 Persisti il validation report

Quando ricevi un CAdES, salva il report DSS:

```js
const reportPath = path.join(CADES_DIR, `validation-${forestUnitId}-${Date.now()}.json`);
fs.writeFileSync(reportPath, JSON.stringify(verifyResult.dssReport, null, 2));
state.cades[forestUnitId].validationReportPath = reportPath;
```

### 5.5 Aggiorna il ricardiano runtime con il livello firma

Dopo la verifica CAdES (in `/api/contract/write2` o equivalente), aggiorna:

```js
const r = state.ricardians[forestUnitId];
if (r?.ricardianForest?.legal?.documentSignature?.userCountersignature) {
  r.ricardianForest.legal.documentSignature.userCountersignature.legalQualification =
    verifyResult.signatureLevel;
  r.ricardianForest.legal.documentSignature.userCountersignature.validationReportRef =
    path.basename(reportPath);
}
```

### 5.6 Test con certificati reali

Procurati 2-3 file `.p7m` di test:
- Uno firmato con QTSP italiano (chiedi a un collega che ha la firma digitale, o usa la tua)
- Uno con un certificato auto-firmato (deve fallire)
- Uno scaduto (deve fallire)

Verifica che `signatureLevel`, `indication`, `validOffchain` siano coerenti.

**Tempo totale**: 1-2 giorni. **Costo**: 0€ (Docker + DSS image, tutto open source).

---

## Step 6 — GDPR baseline documentale (2-3 giorni)

**Goal.** Avere documentazione GDPR scritta. Tutto fatto in casa con template del Garante.

### 6.1 DPIA — Valutazione d'Impatto sulla Protezione dei Dati

Scarica il template ufficiale del Garante: `https://www.garanteprivacy.it/temi/valutazione-d-impatto-sulla-protezione-dei-dati`.

Compila almeno queste sezioni:

- **Descrizione del trattamento**: ancoraggio crittografico di dati forestali per tracciabilità EUDR
- **Necessità e proporzionalità**: minimizzazione (solo hash on-chain), pseudonimizzazione, retention 10 anni
- **Rischi identificati**: 
  - Geolocalizzazione operatori (medio)
  - IPFS pinning come repository pubblico (alto, mitigato escludendo PII da IPFS)
  - Concentrazione dati su un unico fornitore tech (medio)
- **Misure di mitigazione**: cifratura, accesso role-based, audit log, retention enforcement, DPA con sottoscrittori

Salva in `docs/compliance/DPIA-RicardianForestTracking-vYYYYMMDD.md`.

### 6.2 Registro dei trattamenti (art. 30 GDPR)

Template Garante. Una scheda per il trattamento "Tracciabilità forestale RicardianForestTracking":
- Titolare: Sottoscrittore (cliente TopView)
- Responsabile: TopView Srl
- Finalità: tracciabilità EUDR + ancoraggio crittografico
- Categorie interessati: operatori forestali, operatori drone
- Categorie dati: identificativi, geolocalizzazione, professionali
- Destinatari: cliente sottoscrittore, auditor autorizzati
- Trasferimenti extra-UE: nessuno (Ethereum è infrastruttura globale ma le evidenze sono solo hash)
- Tempi di conservazione: 10 anni off-chain; on-chain solo hash, perpetui

### 6.3 Informativa privacy

Template del Garante. Da pubblicare sul portale e linkare nel flusso di onboarding del Sottoscrittore.

Punti chiave da includere:
- Identità del titolare (Sottoscrittore) e responsabile (TopView)
- Finalità: tracciabilità forestale + adempimento EUDR
- Base giuridica: legittimo interesse (art. 6.1.f) per tracciabilità + obbligo legale (art. 6.1.c) se EUDR è applicabile
- Diritti dell'interessato: accesso, rettifica, cancellazione (con avvertenza che on-chain è registrato solo hash, irrevocabile)
- Modalità di esercizio diritti
- Reclamo al Garante

### 6.4 DPA template Issuer ↔ Sottoscrittore

Crea un template di Data Processing Agreement (art. 28 GDPR) che TopView firma con ogni cliente. Punti minimi:
- Oggetto: trattamenti per servizio RicardianForestTracking
- Durata: durata contratto + 10 anni archiviazione
- Natura e finalità: come da descrizione del trattamento
- Tipi di dati personali: identificativi, geolocalizzazione, dati professionali operatori
- Categorie di interessati: operatori forestali, operatori drone
- Obblighi del Responsabile (TopView): cifratura, riservatezza, sub-processor solo con consenso, notifica data breach 24h, supporto a esercizio diritti, restituzione/cancellazione a fine trattamento
- Audit right del Titolare

Mettilo in `docs/compliance/DPA-template.md`.

### 6.5 Audit IPFS per PII

Verifica che i payload caricati su IPFS non contengano PII:
- Il `ricardianForest` JSON contiene `parties.subscriber.legalEntity` (P.IVA, ragione sociale): è dato di persona giuridica, **non** PII
- Le `notes` e `observations` di alberi/tronchi possono contenere riferimenti a operatori → audit nel codice di importazione TopView
- Le coordinate sono dato personale potenziale (geolocalizzazione attività professionali) → considerare pseudonimizzazione

Se trovi PII nel payload IPFS:
- **Opzione A (raccomandata)**: rimuovi le PII dal payload prima del pinning IPFS, conservale solo on-chain in `RICARDIAN_DIR`
- **Opzione B**: cifra il payload prima del pinning con una chiave gestita dal Sottoscrittore (così la "cancellazione" coincide con la perdita della chiave)

### 6.6 Procedura per esercizio diritti

Documento operativo per il customer support:
- Ricezione richiesta (email dedicata `privacy@...`)
- Verifica identità del richiedente
- Diritti accesso/rettifica: estrazione dati off-chain, fornitura entro 30gg
- Diritto cancellazione: cancellazione off-chain + comunicazione che on-chain rimane solo l'hash (non identificativo) — questa è una posizione difendibile ma da motivare nel rispondere
- Diritto opposizione/portabilità

### 6.7 Retention enforcement

Cron job (anche solo bash + cron, oppure node-cron) che ogni notte rimuove file più vecchi di 10 anni:

```js
const cron = require("node-cron");

cron.schedule("0 3 * * *", () => {
  const TEN_YEARS_MS = 10 * 365 * 24 * 60 * 60 * 1000;
  const cutoff = Date.now() - TEN_YEARS_MS;

  for (const dir of [RICARDIAN_DIR, CADES_DIR]) {
    const files = fs.readdirSync(dir);
    for (const f of files) {
      const fp = path.join(dir, f);
      const stat = fs.statSync(fp);
      if (stat.mtimeMs < cutoff) {
        fs.unlinkSync(fp);
        logger.info({ file: fp }, "Retention enforcement: file rimosso (>10 anni)");
      }
    }
  }
});
```

`npm install node-cron` (gratis).

**Tempo totale**: 2-3 giorni. **Costo**: 0€ (template Garante + tempo).

---

## Step 7 — Test E2E e documentazione (1-2 giorni)

**Goal.** Validare l'intera pipeline e produrre la documentazione di compliance.

### 7.1 Test E2E happy path

Script di test che simula:
1. Generazione forest unit fittizia
2. Build batch + Merkle tree
3. Build & sign ricardian v3.0
4. Upload IPFS (se applicabile)
5. Ancoraggio on-chain (testnet)
6. Upload CAdES di test (firma reale di un collega)
7. DSS validate
8. Ancoraggio controfirma
9. Verify finale: tutti i `matches` devono essere `true`

### 7.2 Test E2E negativi

- CAdES con cert auto-firmato → `signatureLevel` deve essere `NA`, `validOffchain` `false`
- CAdES con cert scaduto → `indication` `INDETERMINATE` o `TOTAL_FAILED`
- Manomissione del PDF dopo l'ancoraggio → `pdfBaselineMatches` deve essere `false`
- Manomissione del JSON ricardiano → `hashMatches` deve essere `false`

### 7.3 README aggiornato

Documenta nel README:
- Architettura sintetica (diagramma)
- Setup ambiente (env vars, DSS docker, IPFS daemon)
- Procedure operative principali
- Procedura di verifica (per chi vuole verificare in modo indipendente)
- Limiti dichiarati (cosa non è coperto)

### 7.4 Bundle di compliance

Crea cartella `docs/compliance/` con:
- `analisi_conformita_RicardianForestTracking.md` (l'analisi originale)
- `roadmap_conformita_zero_budget.md` (questo documento)
- `DPIA-RicardianForestTracking.md`
- `registro-trattamenti.md`
- `DPA-template.md`
- `informativa-privacy.md`
- `procedura-diritti-interessati.md`
- `verification-procedure.md`
- `test-e2e-results-YYYYMMDD.md`

Questo bundle è il pacchetto che il tuo capo può mostrare a un cliente, a un auditor o a un avvocato per dimostrare conformità sostanziale.

**Tempo totale**: 1-2 giorni. **Costo**: 0€.

---

## ✅ Cosa hai ottenuto a costo zero

Al termine dei 7 step:

1. ✅ Sicurezza P0 risolta (no chiavi default, TLS, password, rete pubblica)
2. ✅ Logging strutturato e auditabilità
3. ✅ Rate limiting e auth minimale
4. ✅ Ricardian v3.0 con dichiarazioni allineate alla realtà
5. ✅ Validazione CAdES vera (DSS + EU LOTL + OCSP/CRL)
6. ✅ `validOffchain` ora è una verità tecnica difendibile
7. ✅ Riconoscimento automatico del livello di firma (QES/AdES-QC/AdES)
8. ✅ GDPR baseline: DPIA, registro, informativa, DPA, retention enforcement
9. ✅ Test E2E happy + negative
10. ✅ Documentazione di compliance pronta per audit/cliente

Il sistema può legittimamente affermare:

- Validazione temporale non qualificata ex art. 41 eIDAS / art. 8-ter c.3 ✅
- DLT conforme alla definizione dell'art. 8-ter c.1 (su Sepolia/Polygon/mainnet) ✅
- Riconoscimento di FEQ apposta dall'utente con QTSP listato in EU LOTL ✅
- Effetti probatori del documento informatico ex artt. 20-23 CAD e 2702 c.c. **se** il sottoscrittore firma con FEQ verificata ✅
- Misure GDPR baseline implementate e documentate ✅

**Tempo totale Step 1-7**: ~2 settimane full-time o ~4-5 settimane part-time. **Costo**: 0€.

---

## 💰 Sezione "da chiedere al capo"

Dopo aver completato gratis tutto quanto sopra, restano queste decisioni di budget. Ognuna ha pro/contro che gli puoi presentare.

### Decisione 1 — Identificazione informatica delle parti (art. 8-ter c.2)

**Problema.** Senza SPID/CIE login, il requisito di "previa identificazione informatica delle parti" dell'art. 8-ter c.2 L. 12/2019 non è soddisfatto in senso stretto. Si sopperisce contrattualmente (P.IVA del cliente nel `parties.subscriber.legalEntity`), ma la posizione è più debole.

**Opzioni.**

| Opzione | Costo | Note |
|---|---|---|
| **A.** Restare contrattuale (popolare manualmente `parties.subscriber.legalEntity`) | 0€ | Posizione difendibile ma non ortodossa |
| **B.** SPID Hub commerciale (LepidaID, ArubaID, SPIDmod) | ~50-200€/mese | Setup rapido, mantenimento incluso |
| **C.** SPID SP diretto | 1.500-3.000€ setup + 800€/anno mantenimento | Più rigoroso, identità tecnica diretta |
| **D.** CieID integration | 0€ + tempo dev | CIE è gratis ma copertura cittadini < SPID |
| **E.** Attendere EUDI Wallet (2026-2027) | 0€ | Sarà gratis ma non oggi |

**Raccomandazione.** A se il cliente è B2B con contratti formali (frequentemente il caso EUDR), B se serve identificazione personale degli operatori, D se il caso d'uso è prevalentemente PA o cittadini.

### Decisione 2 — Marche temporali qualificate (CAdES-T server-side)

**Problema.** Se il sottoscrittore firma con il proprio QTSP (es. firma remota Aruba/Namirial), il timestamp qualificato è **già incluso** nel suo CAdES. Tu paghi zero. Se invece vuoi che il server aggiunga marche temporali a CAdES che non le hanno, serve abbonamento TSA.

**Opzioni.**

| Opzione | Costo | Note |
|---|---|---|
| **A.** Affidarsi al timestamp che il firmatario porta nel suo CAdES | 0€ | DSS lo verifica gratis. Default raccomandato. |
| **B.** Contratto TSA per ri-timestamping server-side | ~30-100€ ogni 1.000 marche | Solo se necessario |

**Raccomandazione.** A nel 95% dei casi. La firma qualificata è atto del firmatario, non della piattaforma.

### Decisione 3 — Anchoring chain di produzione

**Problema.** Sepolia è testnet, non produzione. Per produzione servono ETH/MATIC reali per pagare il gas.

**Opzioni.**

| Chain | Costo per ancoraggio | Note |
|---|---|---|
| Ethereum mainnet | ~1-5€ tx | Massima credibilità giuridica |
| Polygon PoS | ~0,01-0,05€ tx | Compromesso |
| Arbitrum | ~0,10-0,30€ tx | L2 di Ethereum, ottimo equilibrio |
| Polygon Amoy / Sepolia | 0€ | Solo per test |

**Raccomandazione.** Polygon o Arbitrum per produzione iniziale (~50-200€/anno per volumi medi). Se il cliente è grande e vuole "Ethereum" come keyword, mainnet con batching (un ancoraggio settimanale che copre N forest unit).

### Decisione 4 — Conservazione a norma (futura)

**Problema.** Il filesystem locale + 10 anni dichiarati nel ricardiano non sono conservazione a norma italiana.

**Opzioni.**

| Opzione | Costo | Note |
|---|---|---|
| **A.** Restare conservazione semplice | 0€ | Dichiarato esplicitamente nel ricardiano v3.0 (`disclaimers.archivalStatus`) |
| **B.** Integrazione conservatore accreditato (ParER, InfoCert, Aruba, Namirial) | 3-15€/anno per documento | Richiesto solo se cliente vuole pieno valore probatorio long-term |

**Raccomandazione.** A per ora. B solo se un cliente specifico la richiede contrattualmente.

### Decisione 5 — KMS per chiave di sistema

**Problema.** La chiave Ethereum del server è oggi caricata da env var. In produzione dovrebbe essere in KMS/HSM.

**Opzioni.**

| Opzione | Costo | Note |
|---|---|---|
| **A.** Env var con accesso ristretto + audit | 0€ | Accettabile per inizio produzione |
| **B.** AWS KMS / GCP KMS | ~3-10€/mese | Standard industry |
| **C.** HashiCorp Vault self-hosted | 0€ infra + tempo setup | Open source |
| **D.** HSM hardware FIPS 140-2 | 5-20k€ + manutenzione | Solo se diventa servizio qualificato |

**Raccomandazione.** A per i primi 6 mesi, poi C (Vault) come investimento di tempo, non di soldi.

### Decisione 6 — Certificazione ISO/IEC 27001

**Costo:** 30-80k€ + 10k€/anno mantenimento.

**Raccomandazione.** Solo se il cliente lo richiede contrattualmente. Nel ricardiano v3.0 è già rimosso come claim di certificazione, quindi non c'è esposizione legale immediata.

---

## Riepilogo decisioni di budget

| # | Decisione | Costo minimo | Costo medio | Necessità |
|---|---|---|---|---|
| 1 | SPID/CIE login | 0€ (opzione A) | 50-200€/mese (opzione B) | Alta se vuoi piena conformità art. 8-ter c.2 |
| 2 | Marche temporali server-side | 0€ (opzione A) | ~50€/1k marche | Bassa (di solito le porta il firmatario) |
| 3 | Chain di produzione | 0€ (testnet) | 50-200€/anno (Polygon/Arbitrum) | Alta per andare in prod reale |
| 4 | Conservazione a norma | 0€ | 3-15€/doc/anno | Bassa, on-demand |
| 5 | KMS | 0€ | 3-10€/mese | Media (in 6 mesi) |
| 6 | ISO 27001 | 0€ | 30-80k€ | Bassa, solo se contrattualmente richiesto |

**Stima minima per andare in produzione reale (decisione 3)**: ~100-300€/anno.
**Stima realistica con SPID Hub e KMS (decisioni 1B + 3 + 5)**: ~1.000-3.000€/anno.

Tutto il resto è gratis (Step 1-7).

---

## Cosa portare al capo per la decisione di budget

1. Questo documento
2. Il file `ricardianBase_v3.js` con la nuova struttura
3. L'analisi di conformità completa
4. Tre proposte:
   - **Opzione "Solo gratis"**: Step 1-7, ~0€, conformità sostanziale al 70%
   - **Opzione "Minimal prod"**: Step 1-7 + decisione 3 (Polygon), ~100-300€/anno, conformità 80%
   - **Opzione "Full art. 8-ter"**: Step 1-7 + decisioni 1B + 3 + 5, ~1.500-3.000€/anno, conformità 95%

Il capo sceglie in base al business case (chi è il cliente, quanto vale il contratto, qual è l'esposizione legale).
