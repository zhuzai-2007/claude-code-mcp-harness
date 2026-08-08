import path from "node:path";
import { fileURLToPath } from "node:url";

const TEST_ROOTS = new Set(["runtime", "mcp-server", "scripts", "workspace"]);
const EXCLUDED_SEGMENTS = new Set(["fixture", "fixtures", "node_modules", "runtime-data", ".agent-runs", ".agents"]);

export function selectNodeTests(paths) {
  return [...new Set(paths.map((entry) => String(entry || "").trim().replaceAll("\\", "/"))
    .filter(Boolean)
    .filter((entry) => {
      const segments = entry.split("/");
      return TEST_ROOTS.has(segments[0])
        && entry.endsWith(".test.mjs")
        && !segments.some((segment) => EXCLUDED_SEGMENTS.has(segment));
    }))].sort((left, right) => left.localeCompare(right, "en"));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  let input = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) input += chunk;
  process.stdout.write(selectNodeTests(input.split(/\r?\n/)).join("\n"));
}
