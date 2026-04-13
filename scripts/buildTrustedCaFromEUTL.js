/* eslint-disable no-console */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { XMLParser } = require("fast-xml-parser");

const EU_LOTL_URL = "https://ec.europa.eu/tools/lotl/eu-lotl.xml";
const OUTPUT_DIR = path.resolve(__dirname, "../certs");
const OUTPUT_BUNDLE = path.join(OUTPUT_DIR, "trusted-ca.pem");
const OUTPUT_SPLIT_DIR = path.join(OUTPUT_DIR, "trusted-ca-split");

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  trimValues: true,
  parseTagValue: false,
  removeNSPrefix: true
});

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function asArray(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

function walk(node, visitor) {
  if (node == null) return;
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visitor);
    return;
  }
  if (typeof node !== "object") return;
  visitor(node);
  for (const value of Object.values(node)) {
    walk(value, visitor);
  }
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "ricardian-trust-bundle-builder/1.0"
    }
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} while fetching ${url}`);
  }

  return await res.text();
}

function sha256(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

function normalizePemBody(base64Text) {
  return String(base64Text).replace(/\s+/g, "").trim();
}

function pemWrap(base64Text) {
  const clean = normalizePemBody(base64Text);
  const lines = clean.match(/.{1,64}/g) || [];
  return [
    "-----BEGIN CERTIFICATE-----",
    ...lines,
    "-----END CERTIFICATE-----",
    ""
  ].join("\n");
}

function extractTlUrls(lotlXmlObj) {
  const urls = new Set();

  walk(lotlXmlObj, (node) => {
    // molti LOTL mettono i link in "TSLLocation"
    if (typeof node.TSLLocation === "string" && /^https?:\/\//i.test(node.TSLLocation)) {
      urls.add(node.TSLLocation.trim());
    }

    // fallback: cerca qualunque stringa che sembri una TSL XML
    for (const value of Object.values(node)) {
      if (
        typeof value === "string" &&
        /^https?:\/\/.+\.xml(\?.*)?$/i.test(value) &&
        /tsl|trusted|tl/i.test(value)
      ) {
        urls.add(value.trim());
      }
    }
  });

  return [...urls];
}

function extractCertificatesFromTl(tlXmlObj) {
  const certs = new Map();

  walk(tlXmlObj, (node) => {
    // caso classico: X509Certificate
    if (typeof node.X509Certificate === "string") {
      const b64 = normalizePemBody(node.X509Certificate);
      if (b64.length > 0) {
        certs.set(sha256(b64), b64);
      }
    }

    // in alcuni casi possono esserci array
    for (const certValue of asArray(node.X509Certificate)) {
      if (typeof certValue === "string") {
        const b64 = normalizePemBody(certValue);
        if (b64.length > 0) {
          certs.set(sha256(b64), b64);
        }
      }
    }
  });

  return certs;
}

async function main() {
  ensureDir(OUTPUT_DIR);
  ensureDir(OUTPUT_SPLIT_DIR);

  console.log(`[1/4] Download EU LOTL: ${EU_LOTL_URL}`);
  const lotlXml = await fetchText(EU_LOTL_URL);
  const lotlObj = parser.parse(lotlXml);

  console.log("[2/4] Extracting national Trusted List URLs...");
  const tlUrls = extractTlUrls(lotlObj)
  .filter((u) => /^https?:\/\//i.test(u))
  .filter((u) => {
    const clean = u.split("?")[0].toLowerCase();
    return clean.endsWith(".xml");
  })
  .filter((u) => !/pivot/i.test(u))
  .filter((u) => !/eu-lotl\.xml$/i.test(u))
  .sort();

  if (tlUrls.length === 0) {
    throw new Error("No Trusted List URLs found in EU LOTL");
  }

  console.log(`Found ${tlUrls.length} candidate TL URLs`);

  const allCerts = new Map();
  const failures = [];

  console.log("[3/4] Downloading national Trusted Lists and extracting certificates...");

  for (const url of tlUrls) {
    try {
      console.log(` - ${url}`);
      const tlXml = await fetchText(url);
      const tlObj = parser.parse(tlXml);
      const certs = extractCertificatesFromTl(tlObj);

      for (const [fingerprint, b64] of certs.entries()) {
        allCerts.set(fingerprint, b64);
      }
    } catch (err) {
      failures.push({
        url,
        error: err.message
      });
      console.warn(`   FAILED: ${err.message}`);
    }
  }

  if (allCerts.size === 0) {
    throw new Error("No certificates extracted from Trusted Lists");
  }

  console.log("[4/4] Writing PEM bundle...");
  const bundleParts = [];
  let index = 0;

  for (const [fingerprint, b64] of allCerts.entries()) {
    const pem = pemWrap(b64);
    bundleParts.push(pem);

    const singleName = `${String(index).padStart(5, "0")}-${fingerprint.slice(0, 16)}.pem`;
    fs.writeFileSync(path.join(OUTPUT_SPLIT_DIR, singleName), pem, "utf8");
    index += 1;
  }

  fs.writeFileSync(OUTPUT_BUNDLE, bundleParts.join("\n"), "utf8");

  const report = {
    generatedAt: new Date().toISOString(),
    source: EU_LOTL_URL,
    tlCount: tlUrls.length,
    certificateCount: allCerts.size,
    failures
  };

  fs.writeFileSync(
    path.join(OUTPUT_DIR, "trusted-ca-report.json"),
    JSON.stringify(report, null, 2),
    "utf8"
  );

  console.log("");
  console.log("DONE");
  console.log(`Bundle: ${OUTPUT_BUNDLE}`);
  console.log(`Single certs: ${OUTPUT_SPLIT_DIR}`);
  console.log(`Certificates written: ${allCerts.size}`);
  console.log(`Trusted Lists attempted: ${tlUrls.length}`);
  console.log(`Failures: ${failures.length}`);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});