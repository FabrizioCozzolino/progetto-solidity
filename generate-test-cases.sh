#!/bin/bash
# ============================================================
# generate-test-cases.sh
# Genera tutti i fixture di test per il flusso CAdES del
# Ricardian server: firma issuer, controfirma cliente
# (nidificata + co-firma), e casi negativi.
#
# Uso:
#   chmod +x generate-test-cases.sh
#   ./generate-test-cases.sh /percorso/al/ricardian-Vallombrosa.pdf
#
# Se non passi un PDF esistente, ne viene creato uno finto
# di test (utile se vuoi un fixture 100% autocontenuto, senza
# dipendere da un forestUnitId già registrato sul server).
# ============================================================

set -e

OUT_DIR="./out"
mkdir -p "$OUT_DIR"
cd "$OUT_DIR"

SOURCE_PDF="${1:-}"

echo "=== 0) PDF di test ==="
if [ -n "$SOURCE_PDF" ] && [ -f "$SOURCE_PDF" ]; then
  cp "$SOURCE_PDF" ./ricardian-test.pdf
  echo "Uso il PDF fornito: $SOURCE_PDF"
else
  echo "Nessun PDF fornito, ne creo uno fittizio minimale."
  printf '%%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%%%EOF' > ricardian-test.pdf
fi

# ------------------------------------------------------------
# 1) DUE CERTIFICATI DI TEST DISTINTI (issuer + client)
#    Chiavi RSA + self-signed, così hai il pieno controllo di
#    entrambe le chiavi private (necessario per la co-firma).
# ------------------------------------------------------------
echo "=== 1) Genero certificati di test (issuer + client) ==="

openssl genrsa -out issuer-test-key.pem 2048 2>/dev/null
openssl req -new -x509 -key issuer-test-key.pem -out issuer-test-cert.pem \
  -days 3650 \
  -subj "/C=IT/O=TopView Issuer Test/OU=ISSUER-TEST/CN=issuer-signer-test" \
  -addext "keyUsage=nonRepudiation,digitalSignature"

openssl genrsa -out client-test-key.pem 2048 2>/dev/null
openssl req -new -x509 -key client-test-key.pem -out client-test-cert.pem \
  -days 3650 \
  -subj "/C=IT/O=TopView Client Test/OU=CLIENT-TEST/CN=client-signer-test" \
  -addext "keyUsage=nonRepudiation,digitalSignature"

# Terzo cert "non fidato": non finirà nel trust bundle, per testare
# il caso trustedSignature === false
openssl genrsa -out untrusted-test-key.pem 2048 2>/dev/null
openssl req -new -x509 -key untrusted-test-key.pem -out untrusted-test-cert.pem \
  -days 3650 \
  -subj "/C=IT/O=Nessuno Fidato/OU=UNTRUSTED/CN=untrusted-signer-test"

# Bundle di trust da usare come CADES_CA_FILE (issuer + client, NON untrusted)
cat issuer-test-cert.pem client-test-cert.pem > trusted-ca-test-generated.pem
echo "-> trusted-ca-test-generated.pem creato (issuer + client). Puntaci CADES_CA_FILE per i test."

# ------------------------------------------------------------
# CASO 1 — Firma ISSUER (primo upload, /api/ricardian/cades/upload)
# ------------------------------------------------------------
echo "=== CASO 1: firma issuer (primo upload) ==="
openssl cms -sign \
  -in ricardian-test.pdf \
  -binary -outform DER -nodetach \
  -signer issuer-test-cert.pem -inkey issuer-test-key.pem \
  -out caso1-issuer.pdf.p7m
echo "-> caso1-issuer.pdf.p7m : usa su /api/ricardian/cades/upload"

# ------------------------------------------------------------
# CASO 2 — Controfirma cliente NIDIFICATA (.p7m.p7m)
# ------------------------------------------------------------
echo "=== CASO 2: controfirma cliente NIDIFICATA ==="
openssl cms -sign \
  -in caso1-issuer.pdf.p7m \
  -binary -outform DER -nodetach \
  -signer client-test-cert.pem -inkey client-test-key.pem \
  -out caso2-client-nested.pdf.p7m.p7m
echo "-> caso2-client-nested.pdf.p7m.p7m : usa su /api/ricardian/cades/client-upload (topology attesa: nested)"

# ------------------------------------------------------------
# CASO 3 — Controfirma cliente CO-FIRMA (SignedData unico, 2 SignerInfo)
# ------------------------------------------------------------
echo "=== CASO 3: co-firma (unico SignedData, 2 SignerInfo) ==="
openssl cms -sign \
  -in ricardian-test.pdf \
  -binary -outform DER -nodetach \
  -signer issuer-test-cert.pem -inkey issuer-test-key.pem \
  -signer client-test-cert.pem -inkey client-test-key.pem \
  -out caso3-cosigned.pdf.p7m
echo "-> caso3-cosigned.pdf.p7m : usa su /api/ricardian/cades/client-upload (topology attesa: co-firma, signerCount 2)"

# ------------------------------------------------------------
# CASO 4 — STESSO firmatario riusato (deve essere RIFIUTATO)
#           già confermato manualmente, incluso per completezza
# ------------------------------------------------------------
echo "=== CASO 4: stesso firmatario (deve fallire) ==="
openssl cms -sign \
  -in caso1-issuer.pdf.p7m \
  -binary -outform DER -nodetach \
  -signer issuer-test-cert.pem -inkey issuer-test-key.pem \
  -out caso4-same-signer-nested.pdf.p7m.p7m
echo "-> caso4-same-signer-nested.pdf.p7m.p7m : atteso 'stesso firmatario già registrato' -> rifiuto"

# ------------------------------------------------------------
# CASO 5 — CONTENUTO ALTERATO (PDF diverso da quello registrato)
#           deve far scattare pdfContentMatches === false
# ------------------------------------------------------------
echo "=== CASO 5: PDF alterato dopo la firma (mismatch contenuto) ==="
cp ricardian-test.pdf ricardian-test-tampered.pdf
printf '\n%% tampered' >> ricardian-test-tampered.pdf
openssl cms -sign \
  -in ricardian-test-tampered.pdf \
  -binary -outform DER -nodetach \
  -signer client-test-cert.pem -inkey client-test-key.pem \
  -out caso5-tampered-content.pdf.p7m
echo "-> caso5-tampered-content.pdf.p7m : atteso pdfContentMatches=false -> 400 'non coincide con il PDF registrato'"

# ------------------------------------------------------------
# CASO 6 — Certificato NON in trust bundle (trustedSignature=false)
# ------------------------------------------------------------
echo "=== CASO 6: firmatario non fidato (fuori dal CA bundle) ==="
openssl cms -sign \
  -in caso1-issuer.pdf.p7m \
  -binary -outform DER -nodetach \
  -signer untrusted-test-cert.pem -inkey untrusted-test-key.pem \
  -out caso6-untrusted-signer-nested.pdf.p7m.p7m
echo "-> caso6-untrusted-signer-nested.pdf.p7m.p7m : atteso trustedSignature=false (usando trusted-ca-test-generated.pem come CA, che NON contiene questo cert)"

echo ""
echo "============================================================"
echo "Fixture generati in: $(pwd)"
echo "============================================================"
ls -la caso*.p7m* trusted-ca-test-generated.pem 2>/dev/null
