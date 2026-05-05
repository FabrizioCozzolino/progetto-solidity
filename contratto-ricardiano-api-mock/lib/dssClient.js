/**
 * ============================================================================
 * dssClient.js — wrapper Node.js per Digital Signature Service (DSS) della
 * Commissione UE, esposto come REST locale via Tomcat.
 * ============================================================================
 *
 * Scopo: validare CAdES (.p7m) producendo un report con indicazione del
 * livello di firma (QESig / AdESig-QC / AdESig / NA), stato di revoca,
 * QCStatements, catena di certificati, contro la EU LOTL caricata da DSS.
 *
 * Sostituisce l'uso di `openssl ... -noverify` che NON valida la chain of trust.
 *
 * Prerequisiti:
 *   - DSS demo bundle 6.4 in esecuzione su http://localhost:8080
 *   - Avviato con C:\dss-service\dss-demo-bundle-6.4\Webapp-Startup.bat
 *
 * Variabili d'ambiente:
 *   DSS_URL              base REST (default http://localhost:8080/services/rest)
 *   DSS_TIMEOUT_MS       timeout per chiamata in ms (default 60000)
 *
 * Uso:
 *   const { validateCades } = require("./lib/dssClient");
 *   const report = await validateCades("/path/to/file.p7m");
 *   if (report.ok && report.signatureLevel === "QESig") { ... }
 * ============================================================================
 */

const fs = require("fs");
const axios = require("axios");
const path = require("path");

const DSS_URL = process.env.DSS_URL || "http://localhost:8080/services/rest";
const DSS_TIMEOUT_MS = Number(process.env.DSS_TIMEOUT_MS || 60000);

/**
 * Valida un CAdES detached o attached usando DSS.
 *
 * @param {string} p7mPath - percorso al file .p7m
 * @param {string} [originalPdfPath] - opzionale: percorso al PDF originale
 *   (necessario solo se il CAdES è "detached", cioè non contiene il payload)
 * @returns {Promise<ValidationResult>}
 */
async function validateCades(p7mPath, originalPdfPath = null) {
  if (!fs.existsSync(p7mPath)) {
    return { ok: false, error: `File CAdES non trovato: ${p7mPath}` };
  }

  // Leggi il CAdES e converti in base64
  const p7mBytes = fs.readFileSync(p7mPath);
  const p7mBase64 = p7mBytes.toString("base64");
  const p7mName = path.basename(p7mPath);

  // Costruisci il payload secondo lo schema DSS REST
  const payload = {
    signedDocument: {
      bytes: p7mBase64,
      name: p7mName
    },
    originalDocuments: [],
    policy: null,
    signatureId: null
  };

  // Se è un CAdES detached, aggiungi il documento originale
  if (originalPdfPath && fs.existsSync(originalPdfPath)) {
    const origBytes = fs.readFileSync(originalPdfPath);
    payload.originalDocuments.push({
      bytes: origBytes.toString("base64"),
      name: path.basename(originalPdfPath)
    });
  }

  let response;
  try {
    response = await axios.post(
      `${DSS_URL}/validation/validateSignature`,
      payload,
      {
        timeout: DSS_TIMEOUT_MS,
        headers: { "Content-Type": "application/json" },
        // Risposta grande: alziamo i limiti
        maxContentLength: 50 * 1024 * 1024,
        maxBodyLength: 50 * 1024 * 1024
      }
    );
  } catch (err) {
    return {
      ok: false,
      error: "Chiamata DSS fallita",
      details: err.message,
      rawError: err.response?.data,
      hint: "Verifica che DSS sia in esecuzione: curl http://localhost:8080/services/rest/validation?_wadl"
    };
  }

  const report = response.data;
  if (!report || typeof report !== "object") {
    return {
        ok: false,
        error: "Risposta DSS non valida",
        raw: report
    };
    }
  return parseValidationReport(report);
}



async function validateWithUpgrade(p7mPath, level = "CAdES_BASELINE_T") {
  // ⚠️ salta extend
  return await validateCades(p7mPath);
}

/**
 * Estrae i campi di interesse dal report DSS.
 * NB: la struttura JSON del report DSS è molto verbosa. I path qui sotto
 * sono validi per DSS 6.x. Se cambiano in versioni future, adattare.
 */
function parseValidationReport(report) {
  try {
    // Il report ha tre sezioni principali: SimpleReport, DetailedReport, DiagnosticData
    const simple = report?.SimpleReport;
    const diagnostic = report?.DiagnosticData;

    // Lista delle firme presenti nel CAdES (di solito una sola)
    const sigs = simple?.signatureOrTimestampOrEvidenceRecord
              || simple?.signatureOrTimestamp
              || simple?.Signature
              || [];
    const sig = Array.isArray(sigs) ? sigs[0] : sigs;

    if (!sig) {
      return {
        ok: false,
        error: "Nessuna firma trovata nel report DSS",
        rawReport: report
      };
    }

    // Indication: TOTAL_PASSED | TOTAL_FAILED | INDETERMINATE
    const indication = sig?.Indication
                    || sig?.Signature?.Indication
                    || "UNKNOWN";

    // SubIndication: motivazione in caso di FAIL/INDETERMINATE
    const subIndication = sig?.SubIndication
                       || sig?.Signature?.SubIndication
                       || null;

    // Signature Level: QESig (qualified) | AdESig-QC (advanced w/ qualified cert)
    //                  | AdESig (advanced) | NA (not advanced)
    const signatureLevelRaw = sig?.SignatureLevel
                           || sig?.Signature?.SignatureLevel;
    const signatureLevel = (typeof signatureLevelRaw === "object")
      ? signatureLevelRaw?.value || signatureLevelRaw?.description || "UNKNOWN"
      : signatureLevelRaw || "UNKNOWN";

    // Signature Format (CAdES-BASELINE-B / -T / -LT / -LTA, ecc.)
    const signatureFormat = sig?.SignatureFormat
                         || sig?.Signature?.SignatureFormat
                         || "UNKNOWN";

    // Estrai info sui certificati dalla DiagnosticData
    const certs = (diagnostic?.Certificate || []).map(c => ({
      id: c.Id,
      subject: c.SubjectDistinguishedName?.value
            || c.SubjectDistinguishedName
            || null,
      issuer: c.IssuerDistinguishedName?.value
           || c.IssuerDistinguishedName
           || null,
      notBefore: c.NotBefore,
      notAfter: c.NotAfter,
      trusted: c.Trusted === true || c.Trusted === "true",
      selfSigned: c.SelfSigned === true || c.SelfSigned === "true"
    }));

    // Stato di revoca per il certificato del firmatario
    const revocations = (diagnostic?.Revocation || []).map(r => ({
      id: r.Id,
      status: r.Status || "UNKNOWN",
      productionDate: r.ProductionDate,
      thisUpdate: r.ThisUpdate,
      nextUpdate: r.NextUpdate
    }));

    // QCStatements (per attestare che il certificato è qualificato)
    // OID 0.4.0.1862.1.1 = QcCompliance (eIDAS qualified)
    // OID 0.4.0.1862.1.4 = QcSSCD (qualified signature creation device)
    const signerCert = certs[0] || null;
    let qcCompliance = false;
    let qcSSCD = false;

    if (diagnostic?.Certificate?.[0]?.QcStatements) {
      const qc = diagnostic.Certificate[0].QcStatements;
      qcCompliance = qc?.QcCompliance?.present === true || qc?.QcCompliance === true;
      qcSSCD = qc?.QcSSCD?.present === true || qc?.QcSSCD === true;
    }

    // Timestamp presenti nel CAdES (CAdES-T richiede almeno uno qualificato)
    const timestamps = (diagnostic?.Timestamp || []).map(t => ({
      id: t.Id,
      type: t.Type,
      productionTime: t.ProductionTime,
      signedBy: t.SignedBy
    }));

    // Indicazione sintetica per il chiamante
    const isQualified = signatureLevel.toString().startsWith("QES");
    const isAdvancedWithQc = signatureLevel === "AdESig-QC" || signatureLevel === "AdESeal-QC";
    const passed = indication === "TOTAL_PASSED";

    const isStrongLegal =
    passed &&
    timestamps.length > 0;

    const isTopLevel =
    isStrongLegal &&
    qcCompliance &&
    qcSSCD;

    return {
      ok: true,
      // Campi di sintesi (questi sono quelli che metti in `legal.documentSignature.userCountersignature.legalQualification`)
      passed,
      isQualified,
      isAdvancedWithQc,
      indication,           // TOTAL_PASSED | TOTAL_FAILED | INDETERMINATE
      subIndication,        // motivazione in caso di non-PASSED
      signatureLevel,       // QESig | AdESig-QC | AdESig | NA
      signatureFormat,      // CAdES-BASELINE-B/T/LT/LTA
      // Dettagli
      qcCompliance,         // certificato dichiarato qualified ex eIDAS
      qcSSCD,                // chiave su QSCD
      certificateChain: certs,
      revocationStatus: revocations,
      timestamps,
      hasTimestamp: timestamps.length > 0,
      // Report completi (utili per debug e per persistere come evidenza)
      legal: {
        isValid: passed,
        isStrong: isStrongLegal,
        isTopLevel: isTopLevel
        },
      rawReport: report
    };
  } catch (err) {
    return {
      ok: false,
      error: "Parsing del report DSS fallito",
      details: err.message,
      rawReport: report
    };
  }
}

/**
 * Health check: verifica che DSS sia raggiungibile.
 * Da chiamare allo startup del server per fail-fast se DSS è down.
 */
async function dssHealthCheck() {
  try {
    const res = await axios.get(`${DSS_URL}/validation?_wadl`, { timeout: 5000 });
    return { ok: res.status === 200, status: res.status };
  } catch (err) {
    return {
      ok: false,
      error: err.message,
      hint: "Avvia DSS con C:\\dss-service\\dss-demo-bundle-6.4\\Webapp-Startup.bat"
    };
  }
}

module.exports = {
  validateCades,
  dssHealthCheck,
  validateWithUpgrade
};