# Registro delle Attività di Trattamento
## Sistema: RicardianForestTracking

**Documento ex art. 30 Reg. (UE) 2016/679 (GDPR)**

---

## SEZIONE A — Registro del Titolare del trattamento

Il presente registro deve essere tenuto dal **Sottoscrittore** in qualità di Titolare. TopView Srl fornisce il template; la compilazione e la tenuta sono responsabilità del Titolare.

### Identificazione del Titolare

[DA COMPILARE]

- Ragione sociale: __________________
- P.IVA / CF: __________________
- Sede legale: __________________
- Telefono: __________________
- Email: __________________
- PEC: __________________
- Legale rappresentante: __________________
- DPO (se nominato): __________________

### Scheda di trattamento

| Voce | Contenuto |
|---|---|
| **N. progressivo** | 1 |
| **Denominazione del trattamento** | Tracciabilità forestale RicardianForestTracking |
| **Data inizio trattamento** | [DA COMPILARE] |
| **Finalità del trattamento** | Tracciabilità della filiera del legno, validazione temporale di evidenze, supporto adempimento EUDR (Reg. UE 2023/1115) |
| **Base giuridica** | Art. 6.1.b GDPR (esecuzione contratti con operatori); Art. 6.1.c GDPR (obblighi legali EUDR); Art. 6.1.f GDPR (legittimo interesse alla tracciabilità) |
| **Categorie di interessati** | Operatori forestali; operatori drone; referenti aziendali del Titolare |
| **Categorie di dati personali** | Identificativi (nome, cognome); dati di contatto (email professionale); dati di geolocalizzazione delle attività di raccolta; identificativi professionali |
| **Categorie particolari di dati (art. 9 GDPR)** | NESSUNA |
| **Categorie di destinatari** | TopView Srl (Responsabile); auditor autorizzati; autorità competenti su richiesta; rete blockchain pubblica (solo hash, non dati personali) |
| **Trasferimenti extra-UE** | [DA COMPILARE]. Hash on-chain transitano su rete globale ma non sono dati personali. |
| **Termini di cancellazione** | 10 anni dalla data di registrazione (off-chain); on-chain solo hash conservati perpetuamente |
| **Misure di sicurezza tecniche** | Hashing crittografico keccak256/SHA-256; TLS in transito; RBAC su layer applicativo; API key su endpoint di scrittura; logging con redaction; cron retention enforcement; validazione DSS contro EU LOTL |
| **Misure di sicurezza organizzative** | Procedura di esercizio diritti documentata; DPA fra Titolare e Responsabile firmato; DPIA documentata; formazione operatori (a cura del Titolare) |

---

## SEZIONE B — Registro del Responsabile del trattamento

Il presente registro deve essere tenuto da **TopView Srl** in qualità di Responsabile ex art. 28 GDPR.

### Identificazione del Responsabile

[DA COMPILARE]

- Ragione sociale: TopView Srl
- P.IVA: __________________
- Sede legale: __________________
- Telefono: __________________
- Email: __________________
- PEC: __________________
- Legale rappresentante: __________________
- DPO (se nominato): __________________

### Scheda trattamenti effettuati per conto dei Titolari

| Voce | Contenuto |
|---|---|
| **N. progressivo** | 1 |
| **Servizio erogato** | RicardianForestTracking — piattaforma di tracciabilità forestale e ancoraggio crittografico on-chain |
| **Titolari serviti** | Elenco dei Sottoscrittori del servizio (cfr. registro contratti) |
| **Categorie di trattamento effettuati** | Raccolta dati (via API TopView); normalizzazione; hashing; generazione Merkle tree; firma EIP-712 di sistema; ancoraggio on-chain; archiviazione PDF/JSON; validazione CAdES via DSS; controfirma metadati on-chain; verifica integrità |
| **Trasferimenti extra-UE** | [DA COMPILARE in base a infrastruttura cloud] |
| **Misure di sicurezza tecniche** | Vedi sezione A. In aggiunta: secrets management; HTTPS verso API esterne; firewall di rete; auditing log strutturato; aggiornamenti di sicurezza periodici |
| **Sub-responsabili (sub-processor)** | [DA COMPILARE — es. provider cloud, IPFS, BlockchainNode, DSS hosting] |

### Sub-responsabili autorizzati

Il Responsabile può avvalersi dei seguenti sub-responsabili, previa informazione al Titolare:

[DA COMPILARE — esempio]

| Sub-processor | Servizio fornito | Sede | Garanzie GDPR |
|---|---|---|---|
| [Cloud provider, es. AWS / Azure / GCP] | Hosting infrastruttura | [Regione] | SCC + AV adesi |
| [Nodo blockchain, es. Infura / Alchemy] | Accesso a rete blockchain | Globale | Solo hash, nessun dato personale |
| [IPFS pinning, se usato] | Backup payload non-PII | [Regione] | Solo hash, nessun dato personale |
| [Provider TSA, se acquistato] | Marche temporali RFC 3161 | UE | QTSP elencato in EU LOTL |

---

## Modalità di tenuta del registro

- Formato: documento elettronico
- Aggiornamento: ad ogni variazione significativa del trattamento e comunque almeno annualmente
- Disponibilità: deve essere reso disponibile su richiesta dell'Autorità di controllo (Garante per la Protezione dei Dati Personali)
- Conservazione: per tutta la durata del trattamento e per 5 anni successivi alla cessazione

---

## Firme e data

**Per il Titolare** (Sottoscrittore)

Nome e cognome del legale rappresentante: __________________

Firma: __________________

Data: __________________

**Per il Responsabile** (TopView Srl)

Nome e cognome del legale rappresentante: __________________

Firma: __________________

Data: __________________
