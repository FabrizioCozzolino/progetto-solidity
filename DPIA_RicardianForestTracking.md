# Valutazione d'Impatto sulla Protezione dei Dati (DPIA)
## Sistema: RicardianForestTracking

**Documento ex art. 35 Reg. (UE) 2016/679 (GDPR)**

---

**Titolare del trattamento** [DA COMPILARE — è il Sottoscrittore cliente, NON TopView]
- Ragione sociale: __________________
- P.IVA / CF: __________________
- Sede legale: __________________
- Email/PEC: __________________
- Rappresentante legale: __________________
- DPO (se nominato): __________________

**Responsabile del trattamento** (TopView Srl, ex art. 28 GDPR)
- Ragione sociale: __________________
- P.IVA: __________________
- Sede legale: __________________
- Email/PEC: __________________

**Data di compilazione**: __________________
**Versione**: 1.0
**Prossima revisione**: ogni 12 mesi o al cambiamento sostanziale del sistema

---

## 1. Descrizione sistematica del trattamento

### 1.1 Natura, scopo, contesto, finalità

**Cosa fa il sistema.** RicardianForestTracking è una piattaforma di tracciabilità forestale che produce evidenze crittografiche di integrità e validazione temporale di dataset relativi a unità forestali (alberi, tronchi, segati). I dati sono raccolti sul campo via applicativo mobile da operatori forestali e tramite rilievi aerei effettuati da operatori drone, importati dall'API TopView, normalizzati, aggregati in batch unificato, hashati con keccak256, ancorati on-chain su rete blockchain pubblica EVM-compatibile, e firmati elettronicamente.

**Finalità del trattamento.**
1. Tracciabilità della filiera del legno per supporto alla due diligence ex Reg. (UE) 2023/1115 (EUDR)
2. Prova di esistenza, integrità e riferibilità temporale di dataset forestali a fini di audit, certificazione di sostenibilità, controversie commerciali
3. Sottoscrizione contrattuale di evidenze crittografiche fra le parti

**Base giuridica del trattamento** (art. 6 GDPR).
- Esecuzione di obblighi contrattuali fra il Titolare e i propri operatori (art. 6.1.b GDPR)
- Adempimento di obblighi legali del Titolare, in particolare EUDR (art. 6.1.c GDPR)
- Legittimo interesse del Titolare alla tracciabilità della filiera (art. 6.1.f GDPR)

### 1.2 Categorie di dati trattati

| Categoria | Dato | Origine | Necessità |
|---|---|---|---|
| Identificativi operatori | Nome, cognome | App TopView (operatore registrato) | Identificazione del responsabile della raccolta sul campo |
| Geolocalizzazione | Coordinate GPS (latitudine, longitudine, altitudine) di alberi/tronchi/segati | App mobile + drone | Core del servizio: tracciabilità geografica |
| Temporali | Timestamp delle operazioni di campo | App mobile | Riferibilità temporale dei rilievi |
| Identificativi Sottoscrittore | Ragione sociale, P.IVA del cliente | Onboarding contrattuale | Identificazione delle parti ex art. 8-ter c.2 L. 12/2019 |
| Hash crittografici | SHA-256, keccak256 di documenti e datasets | Generati dal sistema | Pseudonimi di evidenze |
| Hash on-chain | Merkle root e ricardian hash registrati | Registrati on-chain pubblicamente | Validazione temporale ex art. 41 eIDAS |

**Importante**: gli hash crittografici on-chain NON sono dati personali (non consentono identificazione anche con sforzi proporzionati). Sono evidenze di integrità di documenti che esistono off-chain.

### 1.3 Categorie di interessati

1. **Operatori forestali**: dipendenti o collaboratori del Sottoscrittore che effettuano rilievi sul campo
2. **Operatori drone**: dipendenti o collaboratori che effettuano rilievi aerei
3. **Referenti del Sottoscrittore**: persone fisiche che agiscono per conto del cliente (es. firmatari di documenti)

Stima numerica per Sottoscrittore tipo: 5-50 interessati per cliente.

### 1.4 Destinatari dei dati

| Destinatario | Categoria | Finalità |
|---|---|---|
| Sottoscrittore (Titolare) | Soggetto interno al rapporto | Uso primario |
| TopView Srl (Responsabile) | Fornitore tecnologico | Erogazione del servizio |
| Auditor autorizzati | Terzi delegati dal Titolare | Audit di filiera, certificazioni |
| Autorità giudiziaria | Solo su richiesta formale | Adempimento obblighi di legge |
| Rete blockchain pubblica | Infrastruttura tecnica | Ancoraggio hash (NON dati personali) |
| IPFS pubblico | Opzionale, controllato | Backup di payload anonimizzati (NON dati personali) |

### 1.5 Periodo di conservazione

- **On-chain**: hash conservati in modo perpetuo per natura immutabile della blockchain. Non contengono dati personali → ammissibile.
- **Off-chain (filesystem locale)**: 10 anni dalla data di registrazione, in coerenza con art. 2946 c.c. e obblighi di archiviazione documentale. Cron retention enforcement implementato.
- **Dati personali**: conservazione limitata alle finalità del trattamento e comunque non oltre 10 anni salvo obblighi di legge.

### 1.6 Trasferimenti extra-UE

[DA VERIFICARE E COMPILARE]

- Server applicativo: localizzato in [PAESE]
- Backup: localizzato in [PAESE]
- Blockchain ancoraggio: rete pubblica globale. **I nodi sono distribuiti globalmente, ma transitano solo hash crittografici e NON dati personali**. Posizione difendibile: nessun trasferimento extra-UE di dati personali avviene tramite la blockchain.
- IPFS: idem se usato.

Conclusione: [DA COMPILARE in base ai paesi reali]

---

## 2. Valutazione di necessità e proporzionalità

### 2.1 Necessità del trattamento

Il trattamento è necessario per:
- Adempimento obblighi EUDR del Titolare (art. 6.1.c GDPR)
- Tracciabilità della filiera richiesta per certificazioni di sostenibilità
- Validazione temporale e prova di integrità di evidenze forestali

Alternative meno invasive considerate:
- Tracciabilità senza geolocalizzazione precisa → **scartata**: EUDR richiede coordinate al lotto
- Sistema centralizzato senza blockchain → **scartata**: perderebbe il valore di immutabilità e validazione temporale terza
- Anonimizzazione totale degli operatori → **scartata**: serve riferibilità del rilievo per accountability

### 2.2 Proporzionalità

- **Minimizzazione**: on-chain solo hash, mai payload in chiaro
- **Finalità limitata**: dati raccolti esclusivamente per tracciabilità forestale, non per altri scopi
- **Conservazione limitata**: 10 anni con cancellazione automatica
- **Accesso controllato**: role-based access control sul layer applicativo

---

## 3. Valutazione dei rischi per i diritti e le libertà degli interessati

### 3.1 Identificazione dei rischi

| ID | Rischio | Probabilità | Impatto | Livello |
|---|---|---|---|---|
| R1 | Geolocalizzazione operatori potenzialmente correlabile a comportamento lavorativo | Media | Medio | **MEDIO** |
| R2 | Accesso non autorizzato a dataset off-chain (database / filesystem) | Bassa | Alto | **MEDIO** |
| R3 | Perdita di confidenzialità via IPFS pubblico se erroneamente usato per PII | Bassa | Alto | **MEDIO** |
| R4 | Impossibilità di cancellare hash on-chain post richiesta art. 17 GDPR | Alta (per design) | Basso (gli hash non sono PII) | **BASSO** |
| R5 | Esposizione di credenziali in caso di compromissione del server TopView | Bassa | Alto | **MEDIO** |
| R6 | Trasferimento extra-UE inconsapevole via cloud provider non-EU | [DA VALUTARE] | Medio | [DA VALUTARE] |
| R7 | Data breach con esfiltrazione del database completo | Bassa | Alto | **MEDIO** |
| R8 | Manipolazione del PDF ricardiano prima della firma | Bassa (impedito da hash) | Medio | **BASSO** |

### 3.2 Misure tecniche e organizzative di mitigazione

| Rischio | Misure implementate | Misure da implementare |
|---|---|---|
| R1 | Le coordinate sono associate ad alberi/tronchi, non direttamente all'operatore; access control | Considerare pseudonimizzazione operatore in dataset condivisi |
| R2 | RBAC sul layer applicativo; API key sugli endpoint di scrittura (Step 4 roadmap) | Cifratura at-rest dei file off-chain |
| R3 | Ricardiano dichiara `ipfsUsageStatement` con limite a payload non-PII; controllo manuale | Audit automatico contenuto pre-pinning |
| R4 | Per design: on-chain solo hash | Documentazione esplicita per risposta a richieste art. 17 |
| R5 | Step 1 roadmap: no chiavi default, secrets management, TLS attivo | Migrazione a KMS o HSM; rotazione periodica delle chiavi |
| R6 | [DA COMPILARE in base infrastruttura] | Verifica clausole standard contrattuali (SCC) UE-extra-UE se applicabili |
| R7 | Logging strutturato con redaction (Step 3 roadmap); rate limiting | Cifratura at-rest; backup cifrato off-site |
| R8 | Hash crittografico del PDF al momento dell'ancoraggio; verifica integrità in verify | Already implemented |

### 3.3 Misure aggiuntive di sicurezza

- Logging strutturato (`pino`) con redaction automatica di chiavi, password, token
- Cron retention enforcement (cancellazione dopo 10 anni)
- Hash crittografici per garantire integrità
- Validazione formale CAdES tramite DSS della Commissione UE contro EU LOTL
- Smart contract audit-ready (codice pubblico verificabile)
- Procedura di esercizio diritti interessati documentata (vedi sezione 6)

---

## 4. Consultazione interessati e DPO

### 4.1 Coinvolgimento degli interessati

[DA COMPILARE]

- Informativa privacy fornita agli operatori al momento dell'arruolamento nel sistema TopView: [SÌ/NO]
- Modalità di consultazione: [es. tramite il datore di lavoro Sottoscrittore]

### 4.2 Parere del DPO

Parere del DPO del Titolare (Sottoscrittore): [DA RACCOGLIERE — il Titolare è il cliente, quindi è suo dovere coinvolgere il proprio DPO se nominato]

---

## 5. Esito della valutazione

### 5.1 Sintesi del livello di rischio residuo

Dopo l'implementazione delle misure di mitigazione: **RISCHIO RESIDUO BASSO**

Motivazione:
- Nessun trattamento di dati particolari (art. 9 GDPR)
- Nessun trattamento sistematico di dati di minori
- Nessun monitoraggio sistematico su larga scala
- Nessuna profilazione automatizzata con effetti giuridici significativi
- Minimizzazione strutturale (on-chain solo hash)

### 5.2 Necessità di consultazione preventiva al Garante

Ex art. 36 GDPR, la consultazione preventiva al Garante è obbligatoria quando il rischio residuo resta elevato anche dopo le misure di mitigazione. **Nel caso in esame: NON NECESSARIA**, dato il livello di rischio basso.

### 5.3 Decisione finale

[DA FIRMARE]

☐ Il trattamento può procedere come descritto

☐ Il trattamento può procedere con le seguenti condizioni: __________________

☐ Il trattamento richiede modifiche prima dell'avvio

**Firma del Titolare** (legale rappresentante): __________________

**Firma del Responsabile** (TopView Srl): __________________

**Data**: __________________

---

## 6. Allegati

- A. Diagramma di flusso dei dati (data flow diagram)
- B. Registro delle attività di trattamento (art. 30 GDPR)
- C. Data Processing Agreement fra Titolare e Responsabile
- D. Informativa privacy ex artt. 13-14 GDPR
- E. Procedura di esercizio dei diritti degli interessati (artt. 15-22 GDPR)

---

*Documento da compilare con i dati specifici del Titolare (Sottoscrittore). TopView Srl in qualità di Responsabile mette a disposizione questo template e collabora alla compilazione, ma la responsabilità finale della DPIA è del Titolare.*
