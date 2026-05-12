# Tabella di Conformità Normativa
## Progetto: RicardianForestTracking
**Stato:** post Step 1 + 2 + 5 della roadmap (sicurezza P0, Ricardian v3.0, validazione DSS)
**Data:** maggio 2026

---

## Legenda

| Simbolo | Significato |
|---|---|
| ✅ | Conformità sostanziale raggiunta |
| ⚠️ | Conformità parziale o condizionata (vedi note) |
| ❌ | Non conforme / fuori scope |
| ➖ | Non applicabile |

---

## Tabella sintetica (per il capo)

| # | Norma | Articolo/Fonte | Conformità |
|---|---|---|:---:|
| 1 | Reg. (UE) 910/2014 — eIDAS | Art. 25 (firme) | ✅ |
| 2 | Reg. (UE) 910/2014 — eIDAS | Art. 41 (validazione temporale non qualificata) | ✅ |
| 3 | Reg. (UE) 910/2014 — eIDAS | Art. 42 (validazione temporale qualificata) | ⚠️ |
| 4 | Reg. (UE) 910/2014 — eIDAS | Art. 13 (responsabilità TSP) | ✅ |
| 5 | Reg. (UE) 2024/1183 — eIDAS 2.0 | Servizi fiduciari qualificati (artt. 45g-l) | ❌ |
| 6 | Reg. (UE) 2024/1183 — eIDAS 2.0 | EUDI Wallet (artt. 5a-g) | ➖ |
| 7 | Reg. (UE) 2024/1183 — eIDAS 2.0 | Sanzioni TSP non qualificati (art. 16) | ✅ |
| 8 | L. 12/2019 art. 8-ter c.1 | Definizione DLT | ✅ |
| 9 | L. 12/2019 art. 8-ter c.2 | Smart contract e forma scritta | ⚠️ |
| 10 | L. 12/2019 art. 8-ter c.3 | Validazione temporale via DLT | ✅ |
| 11 | D.Lgs. 82/2005 (CAD) | Artt. 20-23 efficacia probatoria documento informatico | ✅ |
| 12 | Codice Civile italiano | Art. 2702 (scrittura privata) | ✅ |
| 13 | Codice Civile italiano | Art. 2712 (riproduzioni meccaniche) | ✅ |
| 14 | Codice Civile italiano | Art. 2946 (prescrizione decennale) | ✅ |
| 15 | Reg. (UE) 2016/679 — GDPR | Art. 5 (principi) | ⚠️ |
| 16 | Reg. (UE) 2016/679 — GDPR | Art. 17 (diritto all'oblio) | ⚠️ |
| 17 | Reg. (UE) 2016/679 — GDPR | Art. 25 (privacy by design) | ✅ |
| 18 | Reg. (UE) 2016/679 — GDPR | Art. 28 (responsabile del trattamento) | ⚠️ |
| 19 | Reg. (UE) 2016/679 — GDPR | Art. 30 (registro trattamenti) | ❌ |
| 20 | Reg. (UE) 2016/679 — GDPR | Art. 32 (sicurezza) | ⚠️ |
| 21 | Reg. (UE) 2016/679 — GDPR | Art. 35 (DPIA) | ❌ |
| 22 | Direttiva (UE) 2022/2555 — NIS 2 | D.Lgs. 138/2024 | ➖ |
| 23 | Direttiva 2007/2/CE — INSPIRE | Metadata geo | ⚠️ |
| 24 | Reg. (UE) 2023/1115 — EUDR | Due diligence deforestazione | ⚠️ |
| 25 | ISO 19115/19157 | Metadata geografici | ⚠️ |
| 26 | ISO/IEC 27001 | Sicurezza informazioni | ⚠️ |
| 27 | ISO 38200 | Chain of custody legno | ⚠️ |
| 28 | ETSI EN 319 122 | Formato CAdES | ✅ |
| 29 | ETSI TS 119 612 | Trusted Lists | ✅ |
| 30 | RFC 5280 | X.509 path validation | ✅ |
| 31 | RFC 6960 | OCSP | ✅ |
| 32 | RFC 3161 | Timestamp protocol | ⚠️ |

**Totali**: ✅ 14 piene · ⚠️ 12 parziali · ❌ 4 non conformi · ➖ 2 non applicabili

---

## Tabella dettagliata

### 1. Reg. (UE) 910/2014, art. 25 — Firme elettroniche

**Significato.** Disciplina i 3 livelli di firma elettronica (semplice/avanzata/qualificata) e i loro effetti giuridici. L'art. 25.2 stabilisce che la firma qualificata ha gli stessi effetti della firma autografa.

**Stato: ✅ Conforme**

Il sistema accetta CAdES qualificati e li valida tramite DSS della Commissione UE contro la EU LOTL ufficiale. Per la sessione di test Vallombrosa, il `signatureLevel` riconosciuto è `QESig` (Qualified Electronic Signature) emesso da ArubaPEC, QTSP italiano listato in EU LOTL. La firma del Sottoscrittore ha quindi gli effetti dell'art. 25.2 eIDAS.

**Evidenza.** Endpoint `/api/ricardian/cades/upload`, response field `dss.signatureLevel: "QESig"`. Report DSS persistito in `storage/cades/validation-*.json`.

---

### 2. Reg. (UE) 910/2014, art. 41 — Validazione temporale NON qualificata

**Significato.** Una validazione temporale non qualificata non viene rifiutata come prova in giudizio solo perché è elettronica, ma non gode della presunzione di accuratezza che invece spetta a quella qualificata.

**Stato: ✅ Conforme**

L'ancoraggio on-chain di `ricardianHash` e `merkleRoot` su rete EVM-compatibile produce gli effetti della validazione temporale non qualificata, in combinato disposto con l'art. 8-ter c.3 L. 12/2019. Il timestamp del block in cui è stata registrata la transazione costituisce prova ammissibile.

**Evidenza.** Smart contract `ForestTracking.sol`, funzione `registerRicardianForest`, transazioni ancorate su Sepolia testnet (chainId 11155111).

---

### 3. Reg. (UE) 910/2014, art. 42 — Validazione temporale QUALIFICATA

**Significato.** Una marca temporale qualificata, emessa da una Time Stamp Authority (TSA) certificata QTSP, gode della **presunzione di accuratezza della data e dell'integrità del dato a cui è apposta**.

**Stato: ⚠️ Parziale**

Oggi il sistema non appone marche temporali qualificate. Il `signedAt` deriva dal `claimedSigningTime` autodichiarato dal firmatario nel CAdES-BASELINE-B. Per soddisfare l'art. 42 servirebbero CAdES-T (Timestamped) con marca RFC 3161 di una TSA qualificata.

**Azione per ✅.** Due opzioni:
1. **A costo zero**: chiedere al firmatario di apporre il timestamp lato suo (checkbox "Aggiungi marca temporale" in ArubaSign / DikeGoSign). Il sistema lo riconosce automaticamente via DSS
2. **A costo basso (~50€/1.000 marche)**: TopView Srl acquista un pacchetto di marche da QTSP italiano e applica timestamp server-side su ogni CAdES caricato

---

### 4. Reg. (UE) 910/2014, art. 13 — Responsabilità prestatore

**Significato.** I TSP rispondono dei danni cagionati per dolo o colpa. I QTSP hanno presunzione di colpa invertita (più gravosa).

**Stato: ✅ Conforme**

Topview Srl si pone come Issuer e si assume la responsabilità ex art. 13 in qualità di TSP non qualificato. La dichiarazione è esplicita nel ricardiano (`disclaimers.qualifiedTrustServiceStatus`).

---

### 5. Reg. (UE) 2024/1183, artt. 45g-l — Servizi fiduciari qualificati eIDAS 2.0

**Significato.** eIDAS 2.0 introduce 5 nuovi servizi qualificati: archiviazione, registro elettronico, attestazione attributi (QEAA), gestione dispositivi remoti, autenticazione siti.

**Stato: ❌ Non applicabile (non rivendicato)**

TopView Srl non è QTSP. Il ricardiano dichiara esplicitamente questo limite. Non c'è violazione perché il sistema non rivendica di essere un servizio qualificato.

**Azione per ✅ (opzionale, strategica).** Percorso 12-24 mesi per diventare QTSP del servizio "Qualified electronic ledger" (artt. 45i-l): audit ETSI, accreditamento AgID, costo 50-150k€ + audit biennali. Solo se il business case lo giustifica.

---

### 6. Reg. (UE) 2024/1183, artt. 5a-g — EUDI Wallet

**Significato.** Il portafoglio digitale europeo che dovrà essere disponibile in ogni Stato membro entro dicembre 2026 e accettato dalle relying party entro dicembre 2027.

**Stato: ➖ Non ancora applicabile**

L'obbligo di accettazione del wallet scatta nel 2027 per soggetti regolamentati e PA. Il sistema può predisporsi.

**Azione consigliata.** Nel campo `parties.subscriber.identification.method` del ricardiano, mantenere il valore `"EUDIWallet"` fra quelli ammessi per essere pronti all'integrazione futura.

---

### 7. Reg. (UE) 2024/1183, art. 16 — Sanzioni TSP non qualificati

**Significato.** Novità di eIDAS 2.0: le sanzioni si applicano anche ai prestatori NON qualificati (prima erano riservate ai QTSP).

**Stato: ✅ Conforme**

Il sistema rispetta i requisiti di sicurezza e trasparenza imposti ai TSP non qualificati. In particolare: hardening sicurezza Step 1 della roadmap (no chiavi default, TLS attivo, secrets management), validazione formale DSS, dichiarazioni oneste nei `disclaimers`.

---

### 8. L. 12/2019 art. 8-ter c.1 — Definizione DLT

**Significato.** La legge italiana definisce le DLT come tecnologie con 6 caratteristiche cumulative: condivise, distribuite, replicabili, accessibili simultaneamente, decentralizzate su basi crittografiche, con dati non alterabili.

**Stato: ✅ Conforme (su mainnet o testnet pubblica)**

L'ancoraggio attuale è su Sepolia testnet, che soddisfa tutte e 6 le caratteristiche. Per produzione la chain dovrebbe essere mainnet Ethereum, Polygon o Arbitrum (decisione di budget aperta).

**Evidenza.** Ricardiano JSON, campo `governingLaw` cita esplicitamente l'art. 8-ter; `signature.eip712.domain.chainId: 11155111` (Sepolia).

---

### 9. L. 12/2019 art. 8-ter c.2 — Smart contract e forma scritta

**Significato.** Gli smart contract soddisfano la forma scritta solo se è avvenuta una "identificazione informatica delle parti" prima dell'esecuzione, secondo linee guida AgID.

**Stato: ⚠️ Parziale**

L'attuale `method: "contractual"` (identificazione tramite rapporto contrattuale fra le parti) è una soluzione difendibile per uso B2B ma non costituisce identificazione informatica "forte" secondo le linee guida AgID (che peraltro non sono mai state pubblicate in versione definitiva).

**Azione per ✅.** Integrare SPID/CIE o EUDI Wallet come identity provider e popolare `parties.subscriber.identification.method` con `"SPID-L2"`, `"SPID-L3"`, `"CIE"` o `"EUDIWallet"`. Costo: ~50-200€/mese con SPID Hub commerciale.

---

### 10. L. 12/2019 art. 8-ter c.3 — Validazione temporale via DLT

**Significato.** La memorizzazione di un documento informatico su DLT produce gli effetti dell'art. 41 eIDAS.

**Stato: ✅ Conforme**

Pilastro centrale del progetto. La memorizzazione di `ricardianHash` e `merkleRoot` su blockchain pubblica EVM rientra esattamente in questa fattispecie. Riconoscimento esplicito nel ricardiano (`legal.timeStampValidation.basis`).

---

### 11. D.Lgs. 82/2005 (CAD), artt. 20-23 — Documento informatico

**Significato.** Definiscono l'efficacia probatoria del documento informatico in funzione del tipo di firma apposta e del processo di formazione.

**Stato: ✅ Conforme (per documenti con QES)**

Quando il ricardiano è controfirmato dal Sottoscrittore con firma qualificata (CAdES + cert QTSP), gode dell'efficacia probatoria piena ex artt. 20-23 CAD. Per il test Vallombrosa: condizione soddisfatta (firma QESig di Castaldo con cert ArubaPEC validato da DSS).

**Evidenza.** Validation report DSS in `storage/cades/validation-*.json` con `signatureLevel: "QESig"`.

---

### 12. Codice Civile, art. 2702 — Scrittura privata

**Significato.** La scrittura privata fa piena prova fino a querela di falso se la sottoscrizione è autenticata o riconosciuta. Per il documento informatico, applicabile quando firmato con QES.

**Stato: ✅ Conforme**

Per le stesse ragioni dell'art. 20 CAD, soddisfatto quando c'è QESig validata. Il sistema non lo rivendica per default, ma in caso di firma qualificata l'effetto è automatico per legge.

---

### 13. Codice Civile, art. 2712 — Riproduzioni meccaniche

**Significato.** Le riproduzioni meccaniche/informatiche fanno piena prova se chi è leso non ne disconosce la conformità.

**Stato: ✅ Conforme**

Il PDF ricardiano è un documento informatico riproducibile dal JSON sorgente. Il legame crittografico (`ricardianHash`) lo rende non disconoscibile in modo opponibile.

---

### 14. Codice Civile, art. 2946 — Prescrizione decennale

**Significato.** Il termine ordinario di prescrizione dei diritti è 10 anni.

**Stato: ✅ Conforme**

Il ricardiano dichiara conservazione off-chain a 10 anni in coerenza con questo termine (`dataGovernance.gdprMeasures.retentionPolicy.offChainEvidence`). Cron retention enforcement implementato.

---

### 15. Reg. (UE) 2016/679 — GDPR, art. 5 — Principi

**Significato.** Liceità, correttezza, trasparenza, limitazione delle finalità, minimizzazione, esattezza, limitazione della conservazione, integrità e riservatezza.

**Stato: ⚠️ Parziale**

Implementati: minimizzazione (solo hash on-chain), limitazione conservazione (10 anni), integrità (hash crittografici), riservatezza (access control).

Mancanti: documentazione formale di trasparenza (informativa privacy strutturata), procedura esatta per liceità del trattamento delle coordinate degli operatori.

**Azione per ✅.** Compilare informativa privacy via template Garante (Step 6 della roadmap).

---

### 16. GDPR, art. 17 — Diritto all'oblio

**Significato.** L'interessato ha diritto di ottenere la cancellazione dei propri dati personali.

**Stato: ⚠️ Limitato per design**

L'on-chain registra solo hash crittografici, quindi nessun dato personale. Off-chain i dati possono essere cancellati. **Limite strutturale**: se viene fatto upload su IPFS pubblico con pinning, la cancellazione effettiva diventa impossibile (CID replicato).

**Azione per ✅.** Già implementata: il ricardiano dichiara esplicitamente `ipfsUsageStatement: "limitato a payload privi di dati personali"`. Da verificare che i payload uploaded non contengano effettivamente PII.

---

### 17. GDPR, art. 25 — Privacy by design

**Significato.** Misure tecniche e organizzative implementate "by design" e "by default" per proteggere i dati.

**Stato: ✅ Conforme**

L'architettura del sistema è privacy-by-design: nessun dato personale on-chain, solo hash. Pseudonimizzazione strutturale. Minimizzazione native.

---

### 18. GDPR, art. 28 — Responsabile del trattamento

**Significato.** Il responsabile del trattamento deve operare sulla base di un contratto (DPA, Data Processing Agreement) con il titolare.

**Stato: ⚠️ Parziale**

Il ricardiano dichiara che Issuer (TopView) agisce come Responsabile e il Sottoscrittore come Titolare (`gdprMeasures.personalDataHandling`). **Manca però il DPA contrattuale firmato fra le parti**.

**Azione per ✅.** Predisporre template DPA standard da allegare al contratto di servizio con ogni Sottoscrittore (Step 6 della roadmap).

---

### 19. GDPR, art. 30 — Registro dei trattamenti

**Significato.** Tenere un registro delle attività di trattamento dei dati personali.

**Stato: ❌ Non implementato**

Non esiste oggi un registro formale dei trattamenti effettuati dal sistema RicardianForestTracking.

**Azione per ✅.** Compilare registro via template Garante con tutte le voci: finalità, categorie dati, categorie interessati, destinatari, tempi conservazione, misure di sicurezza (Step 6).

---

### 20. GDPR, art. 32 — Sicurezza del trattamento

**Significato.** Misure tecniche e organizzative adeguate al rischio: cifratura, pseudonimizzazione, integrità, disponibilità, resilienza.

**Stato: ⚠️ Parziale**

Implementati Step 1 della roadmap (hardening P0: no chiavi default, TLS attivo, no password hardcoded). Mancano: cifratura at-rest, vulnerability assessment formale, procedure di incident response documentate.

**Azione per ✅.** Step 4 della roadmap (rate limiting + auth) e cifratura storage delle evidenze.

---

### 21. GDPR, art. 35 — DPIA

**Significato.** Valutazione d'Impatto sulla Protezione dei Dati per trattamenti ad alto rischio.

**Stato: ❌ Non eseguita**

Non esiste DPIA documentata per il progetto. Trattando geolocalizzazione di operatori forestali, è probabilmente necessaria.

**Azione per ✅.** Eseguire DPIA via template Garante (Step 6). Coordinare con il Sottoscrittore in qualità di Titolare.

---

### 22. Direttiva (UE) 2022/2555 — NIS 2

**Significato.** Direttiva sulla cybersecurity, recepita in Italia con D.Lgs. 138/2024. Si applica a "soggetti essenziali" e "importanti" in settori critici.

**Stato: ➖ Verifica applicabilità**

Da verificare se TopView Srl supera le soglie dimensionali NIS 2 (medie/grandi imprese in settori indicati). Se sì: obblighi di gestione rischi, incident reporting (24h/72h/30gg), supply chain security.

**Azione preliminare.** Audit interno per determinare applicabilità.

---

### 23. Direttiva 2007/2/CE — INSPIRE

**Significato.** Direttiva europea sull'infrastruttura per l'informazione territoriale. Definisce metadata e interoperabilità dei dataset geo.

**Stato: ⚠️ Allineato architetturalmente**

Il sistema produce dati georeferenziati in formati compatibili (JSON, GeoJSON, GPKG). Il ricardiano dichiara correttamente "Relevant to" e non "Compliant with" (ammissione onesta).

**Azione per ✅.** La piena conformità INSPIRE richiede metadata profile completo ISO 19115/19139 e pubblicazione tramite Geoportale nazionale. Fuori scope salvo richiesta specifica del cliente.

---

### 24. Reg. (UE) 2023/1115 — EUDR

**Significato.** Il regolamento EU Deforestation-free obbliga operatori e commercianti che immettono nel mercato UE legno e prodotti correlati a dimostrare la non-deforestazione tramite Due Diligence Statement (DDS) e coordinate geografiche al lotto.

**Stato: ⚠️ Supporto strumentale, non compliance integrale**

Il sistema produce evidenze geolocalizzate utili per la DDS. **Non implementati**: integrazione TRACES NT, generazione automatica della DDS, risk assessment deforestazione contro dataset JRC/Hansen.

**Azione per ✅.** Solo se TopView Srl decide di offrire EUDR-as-a-service completo. Roadmap dedicata 3-6 mesi.

---

### 25. ISO 19115/19157 — Metadata geografici

**Significato.** Standard internazionali per la struttura dei metadata geografici e per la valutazione di qualità.

**Stato: ⚠️ Allineato (non certificato)**

Architettura compatibile, modello dati ispirato. Nessuna certificazione formale (e non è una certificazione "di prodotto" in senso classico, ma di processo).

---

### 26. ISO/IEC 27001 — Sicurezza delle informazioni

**Significato.** Standard internazionale per i sistemi di gestione della sicurezza delle informazioni (ISMS).

**Stato: ⚠️ Controlli allineati (non certificato)**

Implementati controlli ispirati a ISO/IEC 27001 (logging, access control, change management). Nessuna certificazione formale.

**Azione per ✅.** Audit di certificazione 30-80k€ + 10k€/anno mantenimento. Solo se richiesto contrattualmente da cliente Enterprise.

---

### 27. ISO 38200 — Chain of custody legno

**Significato.** Standard per la tracciabilità della filiera del legno e dei prodotti derivati.

**Stato: ⚠️ Architettura compatibile**

Il modello di tracciabilità (trees → wood_logs → sawn_timbers + Merkle proof) è compatibile con ISO 38200. Certificazione formale in capo al Sottoscrittore se di interesse commerciale.

---

### 28. ETSI EN 319 122 — Formato CAdES

**Significato.** Standard tecnico europeo che definisce la struttura dei file CAdES (B/T/LT/LTA).

**Stato: ✅ Conforme**

I CAdES caricati e validati seguono lo standard ETSI 319 122. Verifica formale eseguita da DSS della Commissione UE.

---

### 29. ETSI TS 119 612 — Trusted Lists

**Significato.** Standard per la struttura e gestione delle Trusted List europee (LOTL + TL nazionali).

**Stato: ✅ Conforme**

DSS caricato nel sistema integra LOTL caching automatico e verifica i certificati di firma contro le TL ETSI 119 612.

---

### 30. RFC 5280 — X.509 path validation

**Significato.** Standard IETF per la validazione delle catene di certificati X.509.

**Stato: ✅ Conforme**

DSS esegue chain validation completa secondo RFC 5280 (verifica della catena dal cert di firma fino al root CA listato in EU LOTL).

---

### 31. RFC 6960 — OCSP

**Significato.** Online Certificate Status Protocol, per verificare in tempo reale lo stato di revoca dei certificati.

**Stato: ✅ Conforme**

DSS interroga gli endpoint OCSP del QTSP (es. ArubaPEC) durante la validazione.

---

### 32. RFC 3161 — Timestamp protocol

**Significato.** Standard IETF per le marche temporali fornite da TSA (Time Stamp Authority).

**Stato: ⚠️ Pronto ma non utilizzato attivamente**

Il sistema riconosce e valida marche RFC 3161 quando presenti nei CAdES-T. Oggi i CAdES caricati sono CAdES-B (senza timestamp).

**Azione per ✅.** Come per art. 42 eIDAS: chiedere ai firmatari di apporre marca temporale lato loro, oppure acquistare pacchetto TSA.

---

## Quadro riassuntivo per il capo

### Cosa il sistema può legittimamente rivendicare oggi

1. ✅ **Validazione temporale non qualificata** ex art. 41 eIDAS / art. 8-ter c.3 L. 12/2019
2. ✅ **Riconoscimento di Firma Elettronica Qualificata (QESig)** quando l'utente firma con QTSP listato in EU LOTL (verificato formalmente via DSS UE)
3. ✅ **Effetti probatori del documento informatico** ex artt. 20-23 CAD e 2702 c.c. per documenti con QESig
4. ✅ **Conformità all'art. 8-ter c.1 e c.3 L. 12/2019** (definizione DLT + validazione temporale)
5. ✅ **Conformità art. 16 eIDAS 2.0** per TSP non qualificati
6. ✅ **Conformità ETSI 319 122 (CAdES) + ETSI 119 612 (Trusted Lists) + RFC 5280 + RFC 6960** verificate da DSS UE
7. ✅ **Privacy by design** ex art. 25 GDPR

### Cosa manca per arrivare al 100%

In ordine di priorità:

1. **DPIA + registro trattamenti GDPR** (Step 6 roadmap, 2-3 giorni, costo zero)
2. **DPA template** fra Issuer e Sottoscrittore (Step 6, costo zero)
3. **Marche temporali qualificate CAdES-T** per art. 42 eIDAS (chiedere lato firmatario o ~50€/1.000 marche)
4. **Identificazione informatica forte** ex art. 8-ter c.2 (SPID/CIE/EUDI, ~50-200€/mese)
5. **Conservazione a norma** con conservatore accreditato AgID (~3-15€/anno per documento)

### Cosa è fuori scope per il progetto attuale

1. **Status QTSP** (richiede 12-24 mesi e ~50-150k€)
2. **Certificazione ISO 27001** (richiede 30-80k€)
3. **EUDR full compliance** (richiede integrazione TRACES NT)
4. **NIS 2** (da verificare se applicabile in base a dimensioni TopView Srl)

---

*Documento di compliance preliminare. Si raccomanda revisione legale prima di utilizzo in offerta commerciale o presentazione a cliente Enterprise.*
