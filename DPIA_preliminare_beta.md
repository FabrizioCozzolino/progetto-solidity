# DPIA Preliminare — Fase Beta/Test
## Sistema: RicardianForestTracking

**Documento interno di valutazione preliminare ex art. 35 GDPR**

**Stato**: Sistema in fase di sviluppo (BETA / pre-produzione)
**Data**: [DA COMPILARE]
**Versione**: 0.1 (preliminare)
**Compilatore**: __________________

---

## 1. Stato del progetto

RicardianForestTracking è attualmente in **fase di sviluppo beta**, finalizzata a:
- Validazione tecnica della pipeline (hashing, ancoraggio on-chain, validazione CAdES)
- Test di integrazione con API TopView, DSS della Commissione UE, IPFS, rete blockchain
- Verifica della conformità normativa (eIDAS, L. 12/2019, GDPR)

**In questa fase il sistema NON tratta dati personali reali**: tutti gli upload, test di firma e verifiche sono eseguiti con dati fittizi o sintetici. Non vi sono pertanto trattamenti GDPR-rilevanti in corso.

---

## 2. Categorie di dati che SARANNO trattate in produzione

Categoria | Dato previsto | Identificabilità | Decisione finale
---|---|---|---
Operatori forestali | Probabili: nome, cognome, identificativo aziendale; eventualmente recapito telefonico | Sì, dato personale | Da definire con il primo cliente in produzione
Operatori drone | Idem | Sì | Idem
Geolocalizzazione attività | Coordinate GPS dei rilievi di campo | Indirettamente personale (correlazione con operatore) | Confermata
Referente Sottoscrittore | Email, nome, ruolo aziendale | Sì | Confermata
Identificativi Sottoscrittore | Ragione sociale, P.IVA, sede | NON è dato personale (persona giuridica) | Confermata
Hash crittografici | keccak256, SHA-256 | NON è dato personale | Confermata

**Nota**: la lista definitiva sarà completata in DPIA finale, sulla base del concreto perimetro di dati raccolti dal primo cliente in produzione.

---

## 3. Misure tecniche e organizzative già implementate

Anche se non ancora obbligatorie in fase beta, le seguenti misure sono già operative:

### Sicurezza tecnica
- Rimozione di chiavi e credenziali di default dal codice
- TLS attivo in tutte le comunicazioni verso API esterne
- Secrets management via environment variables (no hardcoded)
- Hashing crittografico keccak256 / SHA-256 per integrità
- Validazione formale CAdES tramite DSS della Commissione UE contro EU LOTL
- Logging strutturato senza esposizione di credenziali

### Privacy by design
- On-chain: solo hash crittografici, mai dati personali in chiaro
- Minimizzazione strutturale (architettura per design)
- IPFS limitato a payload non-PII (dichiarato in `disclaimers.ipfsUsageStatement`)

### Governance
- Retention policy dichiarata: 10 anni off-chain
- Disclaimer espliciti nel ricardiano sui limiti del servizio
- Identificazione contrattuale del Sottoscrittore via `parties.subscriber.identification`

---

## 4. Rischi previsti per la fase di produzione

Identificati preliminarmente:

ID | Rischio | Mitigazione prevista
---|---|---
R1 | Geolocalizzazione correlabile al comportamento lavorativo degli operatori | Pseudonimizzazione, access control
R2 | Accesso non autorizzato a dataset off-chain | Cifratura at-rest da implementare prima del go-live
R3 | Errato uso di IPFS pubblico con PII | Audit pre-pinning del payload
R4 | Impossibilità di cancellazione hash on-chain | Per design: gli hash non sono dati personali
R5 | Compromissione credenziali del server | Migrazione a KMS prevista prima del go-live

La valutazione di rischio completa sarà documentata nella DPIA finale.

---

## 5. Impegni per il passaggio in produzione

Prima di andare in produzione con dati reali, TopView Srl si impegna a:

- [ ] Compilare DPIA completa ex art. 35 GDPR con il primo cliente reale
- [ ] Compilare registro dei trattamenti ex art. 30 GDPR
- [ ] Firmare DPA con ogni Sottoscrittore in qualità di Titolare
- [ ] Pubblicare informativa privacy ex artt. 13-14 GDPR
- [ ] Definire procedura per esercizio dei diritti degli interessati (artt. 15-22)
- [ ] Nominare DPO se le soglie di applicabilità lo richiedono
- [ ] Implementare cifratura at-rest dei dataset off-chain
- [ ] Migrazione a KMS / HSM per la chiave di firma di sistema
- [ ] Eventuale acquisto pacchetto marche temporali QTSP per CAdES-T

---

## 6. Dichiarazione di stato

Allo stato attuale (fase beta), il trattamento NON ricade nell'ambito di applicazione del GDPR perché non vi sono dati personali reali in trattamento. La presente DPIA preliminare ha valore di pianificazione e dichiarazione di intenti, e sarà sostituita da DPIA completa al momento del passaggio in produzione.

---

## 7. Firme

**Compilatore**: __________________

**Approvato da** (legale rappresentante TopView Srl): __________________

**Data**: __________________

**Prossima revisione**: alla prima evidenza di dati personali reali in trattamento, e comunque non oltre 6 mesi dalla data odierna.
