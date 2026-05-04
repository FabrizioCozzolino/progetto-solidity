const path = require("path");
const fs = require("fs");

const { validateWithUpgrade, dssHealthCheck } = require("./lib/dssClient");

(async () => {
  const filePath = path.resolve(
    __dirname,
    "contratto-ricardiano-api-mock/storage/cades/ricardian-Vallombrosa.pdf.p7m"
  );

  console.log("=== Health check ===");
  console.log(await dssHealthCheck());

  console.log("\n=== Validate test CAdES ===");

  const result = await validateWithUpgrade(filePath);

  if (!result.ok) {
    console.error("❌ Processo fallito:", result);
    return;
  }

  console.log("OK:", result.ok);
  console.log("Indication:", result.indication);
  console.log("Signature level:", result.signatureLevel);
  console.log("Signature format:", result.signatureFormat);
  console.log("Is qualified:", result.isQualified);
  console.log("QcCompliance:", result.qcCompliance);
  console.log("QcSSCD:", result.qcSSCD);
  console.log("Has timestamp:", result.hasTimestamp);
  console.log("Cert chain length:", result.certificateChain?.length);

  console.log("\n=== LEGAL ===");
  console.log(result.legal);

  if (result.rawReport) {
    fs.writeFileSync(
      "./test-dss-report.json",
      JSON.stringify(result.rawReport, null, 2)
    );
    console.log("\nReport salvato");
  }
})();