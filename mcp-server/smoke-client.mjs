import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { diffSnapshots, hasUnexpectedSideEffects, snapshotTree } from "./side-effect-guard.mjs";

const serverUrl = process.env.MCP_SERVER_URL || "http://127.0.0.1:8787/mcp";
const realPlan = process.env.MCP_REAL_PLAN === "1";
const realWrite = process.env.MCP_REAL_WRITE === "1";
const maxBudgetUsd = Number(process.env.MCP_MAX_BUDGET_USD || "0.20");
const resultRunId = process.env.MCP_RESULT_RUN_ID || "";
const expectedSummaryMinLength = Number(process.env.MCP_EXPECT_SUMMARY_MIN_LENGTH || "0");
const client = new Client({ name: "codex-claude-worker-smoke", version: "0.1.0" });
const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(moduleDirectory, "..");
const writeMarker = "MCP_REAL_WRITE_OK";
const unicodePlanMarker = "编码检查：“中文”—OK";
const writeRelativePath = `workspace/mcp-real-write-smoke-${process.pid}-${Date.now()}.txt`;
const writeAbsolutePath = path.resolve(projectRoot, writeRelativePath);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

try {
  await client.connect(new StreamableHTTPClientTransport(new URL(serverUrl)));

  const listed = await client.listTools();
  const toolNames = listed.tools.map((tool) => tool.name);
  for (const required of ["cc_ping", "cc_plan_task", "cc_get_result", "cc_get_ledger"]) {
    assert(toolNames.includes(required), `Missing MCP tool: ${required}`);
  }
  const writeTool = listed.tools.find((tool) => tool.name === "cc_run_approved_task");
  assert(writeTool?.annotations?.readOnlyHint === false, "cc_run_approved_task is not marked as write-capable");
  assert(writeTool?.annotations?.destructiveHint === true, "cc_run_approved_task does not advertise overwrite risk");

  const ping = await client.callTool({ name: "cc_ping", arguments: {} });
  assert(ping.structuredContent?.ok === true, "cc_ping did not report ok=true");

  const plan = await client.callTool(
    {
      name: "cc_plan_task",
      arguments: {
        prompt: realPlan
          ? `Read README.md and report its first heading in the required structured response. Include this exact Unicode marker in summary: ${unicodePlanMarker}. Do not modify files.`
          : "Read README.md and report its first heading in the required structured response. Do not modify files.",
        mockWorker: !realPlan,
        workerTimeoutSeconds: realPlan ? 120 : 30,
        maxBudgetUsd
      }
    },
    undefined,
    { timeout: realPlan ? 180000 : 60000 }
  );
  const runId = plan.structuredContent?.runId;
  assert(/^\d{8}-\d{6}-\d{3}$/.test(runId || ""), `cc_plan_task did not return a runId: ${JSON.stringify(plan)}`);
  assert(plan.structuredContent?.result?.status === "success", "cc_plan_task did not return its normalized success result");
  if (realPlan) {
    assert(
      plan.structuredContent?.result?.summary?.includes(unicodePlanMarker),
      `Real plan did not preserve the exact Unicode marker: ${JSON.stringify(plan.structuredContent?.result?.summary)}`
    );
  }

  const exact = await client.callTool({ name: "cc_get_result", arguments: { runId } });
  assert(exact.structuredContent?.status === "success", "cc_get_result did not find the exact runId");
  assert(exact.structuredContent?.runId === runId, "cc_get_result returned a different runId");

  if (resultRunId) {
    const requested = await client.callTool({ name: "cc_get_result", arguments: { runId: resultRunId } });
    const summaryLength = requested.structuredContent?.result?.summary?.length || 0;
    assert(requested.structuredContent?.status === "success", `cc_get_result did not find requested regression run ${resultRunId}`);
    assert(summaryLength >= expectedSummaryMinLength, `cc_get_result summary was truncated: ${summaryLength} < ${expectedSummaryMinLength}`);
  }

  const beforeWrite = realWrite ? await snapshotTree(projectRoot) : null;
  const write = await client.callTool({
    name: "cc_run_approved_task",
    arguments: {
      prompt: realWrite
        ? `Using only Read, Write, or Edit tools, create the project-relative file ${writeRelativePath} with exactly this single line: ${writeMarker}. Do not use Bash or shell commands. Do not create directories. Do not modify any other path.`
        : "Mock protocol smoke only. Do not create or modify files.",
      approvedBy: "protocol-smoke",
      approvalReason: realWrite
        ? "Exercise the approved write-capable MCP route with a bounded real worker."
        : "Exercise the approved write-capable MCP route with MockWorker.",
      mockWorker: !realWrite,
      workerTimeoutSeconds: realWrite ? 120 : 30,
      maxBudgetUsd
    }
  });
  const writeRunId = write.structuredContent?.runId;
  assert(/^\d{8}-\d{6}-\d{3}$/.test(writeRunId || ""), "cc_run_approved_task did not return a runId");
  assert(
    write.structuredContent?.result?.status === "success",
    `cc_run_approved_task ${realWrite ? "real" : "mock"} route failed: ${JSON.stringify(write.structuredContent)}`
  );
  assert(write.structuredContent?.result?.mode === "run", "cc_run_approved_task returned the wrong mode");
  if (realWrite) {
    const written = await readFile(writeAbsolutePath, "utf8");
    assert(written.trim() === writeMarker, `Real write smoke produced unexpected content: ${JSON.stringify(written)}`);
    const afterWrite = await snapshotTree(projectRoot);
    const sideEffects = diffSnapshots(beforeWrite, afterWrite, {
      allowedFiles: [writeRelativePath],
      allowedDirectories: [path.posix.dirname(writeRelativePath)]
    });
    assert(!hasUnexpectedSideEffects(sideEffects), `Real write smoke produced undeclared filesystem side effects: ${JSON.stringify(sideEffects)}`);
  }

  const latest = await client.callTool({ name: "cc_get_result", arguments: { runId: "latest" } });
  assert(latest.structuredContent?.runId === writeRunId, "cc_get_result latest did not resolve to the just-completed run");

  console.log(JSON.stringify({ ok: true, serverUrl, realPlan, realWrite, maxBudgetUsd, toolNames, planRunId: runId, writeRunId }, null, 2));
} finally {
  await client.close();
  if (realWrite) await rm(writeAbsolutePath, { force: true });
}
