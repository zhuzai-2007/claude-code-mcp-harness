import path from "node:path";
import { fileURLToPath } from "node:url";
import { ProviderPreflightService } from "../runtime/provider-preflight.mjs";

const args = process.argv.slice(2);
const json = args.includes("--json");
const timeoutIndex = args.indexOf("--timeout");
const timeoutSeconds = timeoutIndex >= 0 ? Number(args[timeoutIndex + 1]) : 60;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const service = new ProviderPreflightService({ runtimeDataRoot: path.join(repoRoot, "runtime-data") });
const result = await service.run({ timeoutSeconds });

if (json) console.log(JSON.stringify(result));
else {
  console.log(`Provider preflight: ${result.status === "ok" ? "OK" : "FAILED"}`);
  console.log(`Classification: ${result.classification}`);
  console.log(result.message);
  console.log("Safety: fixed prompt, isolated empty directory, no tools, no session persistence, no project content.");
  for (const step of result.recoverySteps || []) console.log(`Next: ${step}`);
}
process.exitCode = result.status === "ok" ? 0 : 2;
