import { createHash, randomBytes } from "node:crypto";
import { lstat, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const TERMINAL_WORKFLOW_STATUSES = new Set(["completed", "succeeded", "failed"]);
const REVIEW_CONCLUSIONS = new Set(["accept", "revise", "investigate"]);
const MAX_PROJECT_MEMORY_BYTES = 64 * 1024;

function nowIso() { return new Date().toISOString(); }
function digest(value) { return createHash("sha256").update(String(value || "")).digest("hex"); }
function memoryDigest(value) { return digest(String(value || "").replace(/^\uFEFF/, "").trim()); }
function cleanText(value, name, maximum = 6000) {
  const text = String(value || "").trim();
  if (!text || text.length > maximum) throw new Error(`${name} must contain 1-${maximum} characters.`);
  return text;
}
function cleanOptionalText(value, maximum = 6000) {
  const text = String(value || "").trim();
  if (text.length > maximum) throw new Error(`Text must contain at most ${maximum} characters.`);
  return text || null;
}
function cleanList(values, name, maximumItems = 30, maximumLength = 2000) {
  if (values == null) return [];
  if (!Array.isArray(values) || values.length > maximumItems) throw new Error(`${name} must be an array with at most ${maximumItems} items.`);
  return [...new Set(values.map((value) => cleanText(value, name, maximumLength)))];
}
function line(value) { return String(value || "").replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim(); }

async function writeTextAtomic(filePath, value) {
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${randomBytes(4).toString("hex")}`;
  await writeFile(temporaryPath, value, "utf8");
  let lastError;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try { await rename(temporaryPath, filePath); return; }
    catch (error) {
      lastError = error;
      if (!new Set(["EPERM", "EACCES", "EBUSY"]).has(error?.code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10 * 2 ** attempt));
    }
  }
  throw lastError;
}

export function buildMemoryApplicationDocument(existingContent, proposal, application) {
  const existing = String(existingContent || "").replace(/^\uFEFF/, "").trimEnd();
  const heading = "## Recent Evolution";
  const base = existing || "# Project Memory\n\n## Stable Facts\n\n<!-- Long-lived project facts belong here. -->\n\n## Architecture Decisions\n\n<!-- Durable decisions, rationale, date, and impact belong here. -->\n\n## Recent Evolution";
  const withRecentLayer = base.includes(heading) ? base : `${base}\n\n${heading}`;
  const changes = (proposal.suggestedMemoryChanges || []).map((item) => `- ${line(item)}`).join("\n");
  const entry = [
    `### ${application.appliedAt.slice(0, 10)} — ${line(proposal.summary || proposal.workflowId)}`,
    "",
    `- Workflow: \`${line(proposal.workflowId)}\``,
    `- Proposal: \`${line(proposal.proposalId)}\``,
    `- Applied by: ${line(application.appliedBy)}`,
    `- Confirmation: ${line(application.confirmationReason)}`,
    ...(changes ? [changes] : []),
    ""
  ].join("\n");
  return `${withRecentLayer}\n\n${entry}`;
}

export class ProjectIntelligenceService {
  constructor({ workflowRuntime, projectRegistry, store }) {
    this.workflowRuntime = workflowRuntime;
    this.projectRegistry = projectRegistry;
    this.store = store;
  }

  async inspectWorkflow(workflowId) {
    return this.workflowRuntime.inspectWorkflow
      ? this.workflowRuntime.inspectWorkflow(workflowId)
      : this.workflowRuntime.getWorkflow(workflowId);
  }

  async getWorkflowIntelligence(workflowId) {
    const workflow = await this.inspectWorkflow(workflowId);
    if (!workflow) return null;
    const projectId = workflow.projectId || workflow.project?.projectId || workflow.project?.id || null;
    const [reviewResults, memoryProposal, memoryApplications] = await Promise.all([
      this.store.listSupervisorReviewResults(workflowId),
      this.store.readMemoryUpdateProposal(workflowId),
      projectId ? this.store.listMemoryApplications({ projectId, workflowId }) : []
    ]);
    return {
      schemaVersion: 1,
      workflowId,
      projectId,
      reviewResults,
      latestReview: reviewResults[0] || null,
      memoryProposal,
      memoryApplications,
      latestMemoryApplication: memoryApplications[0] || null
    };
  }

  async recordSupervisorReview({ workflowId, conclusion, goalAlignment, architectureAssessment, risks = [], recommendations = [], nextSteps = [], memoryUpdateNeeded = null, submittedBy, confirmationReason, confirmed }) {
    if (confirmed !== true) throw new Error("explicit_confirmation_required: Supervisor Review Result requires an explicit user confirmation.");
    if (!REVIEW_CONCLUSIONS.has(conclusion)) throw new Error(`Invalid Supervisor Review conclusion: ${conclusion}`);
    const workflow = await this.inspectWorkflow(workflowId);
    if (!workflow) throw new Error(`Workflow not found: ${workflowId}`);
    if (!TERMINAL_WORKFLOW_STATUSES.has(workflow.status)) throw new Error("workflow_not_terminal: Supervisor Review Result can only attach to a completed or failed Workflow.");
    if (memoryUpdateNeeded !== null && typeof memoryUpdateNeeded !== "boolean") throw new Error("memoryUpdateNeeded must be boolean or null.");
    const projectId = workflow.projectId || workflow.project?.projectId || workflow.project?.id || null;
    const createdAt = nowIso();
    const result = {
      schemaVersion: 1,
      reviewId: `supervisor_review_${Date.now().toString(36)}_${randomBytes(6).toString("hex")}`,
      workflowId,
      projectId,
      reviewer: "chatgpt_supervisor",
      source: {
        channel: "chatgpt_web_mcp",
        submittedBy: cleanText(submittedBy, "submittedBy", 100),
        confirmation: { confirmed: true, reason: cleanText(confirmationReason, "confirmationReason", 1000) }
      },
      conclusion,
      goalAlignment: cleanText(goalAlignment, "goalAlignment"),
      architectureAssessment: cleanText(architectureAssessment, "architectureAssessment"),
      risks: cleanList(risks, "risks"),
      recommendations: cleanList(recommendations, "recommendations"),
      nextSteps: cleanList(nextSteps, "nextSteps"),
      memoryUpdateNeeded,
      createdAt
    };
    return this.store.writeSupervisorReviewResult(result);
  }

  async applyMemoryProposal({ workflowId, proposalId, appliedBy, confirmationReason, confirmed }) {
    if (confirmed !== true) throw new Error("explicit_confirmation_required: Memory Proposal cannot be applied without explicit confirmation.");
    const workflow = await this.inspectWorkflow(workflowId);
    if (!workflow) throw new Error(`Workflow not found: ${workflowId}`);
    if (!TERMINAL_WORKFLOW_STATUSES.has(workflow.status)) throw new Error("workflow_not_terminal: Memory Proposal can only be applied for a completed or failed Workflow.");
    const proposal = await this.store.readMemoryUpdateProposal(workflowId);
    if (!proposal) throw new Error(`Memory Update Proposal not found: ${workflowId}`);
    if (proposal.proposalId !== proposalId) throw new Error(`Memory Update Proposal mismatch: ${proposalId}`);
    if (proposal.status !== "proposed" || proposal.applied === true) throw new Error("memory_proposal_not_applicable: Proposal is not pending confirmation.");
    const projectId = workflow.projectId || workflow.project?.projectId || workflow.project?.id || null;
    if (!projectId || proposal.projectId !== projectId) throw new Error("project_binding_mismatch: Proposal is not bound to this Workflow project.");
    const context = this.projectRegistry.getProjectContext(projectId);
    const workspacePath = path.resolve(context.project.workspacePath);
    const memoryPath = path.resolve(workspacePath, "PROJECT_MEMORY.md");
    const relative = path.relative(workspacePath, memoryPath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("memory_path_escape: Refusing to write outside the registered project.");
    try {
      const details = await lstat(memoryPath);
      if (details.isSymbolicLink() || !details.isFile()) throw new Error("PROJECT_MEMORY.md must be a regular file.");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    let existing = "";
    try { existing = await readFile(memoryPath, "utf8"); }
    catch (error) { if (error?.code !== "ENOENT") throw error; }
    const appliedAt = nowIso();
    const application = {
      schemaVersion: 1,
      applicationId: `memory_apply_${Date.now().toString(36)}_${randomBytes(6).toString("hex")}`,
      proposalId,
      workflowId,
      projectId,
      status: "applying",
      appliedBy: cleanText(appliedBy, "appliedBy", 100),
      appliedAt,
      confirmationReason: cleanText(confirmationReason, "confirmationReason", 1000),
      modificationSummary: `Append confirmed Workflow evidence to the Recent Evolution layer of PROJECT_MEMORY.md.`,
      memoryPath: "PROJECT_MEMORY.md",
      beforeDigest: memoryDigest(existing),
      afterDigest: null,
      createdAt: appliedAt
    };
    await this.store.writeMemoryApplication(application);
    try {
      const updated = buildMemoryApplicationDocument(existing, proposal, application);
      if (Buffer.byteLength(updated, "utf8") > MAX_PROJECT_MEMORY_BYTES) throw new Error(`PROJECT_MEMORY.md would exceed ${MAX_PROJECT_MEMORY_BYTES} bytes.`);
      await writeTextAtomic(memoryPath, updated);
      const completed = { ...application, status: "applied", afterDigest: memoryDigest(updated) };
      await this.store.writeMemoryApplication(completed);
      const appliedProposal = {
        ...proposal,
        status: "applied",
        applied: true,
        application: {
          applicationId: completed.applicationId,
          appliedBy: completed.appliedBy,
          appliedAt: completed.appliedAt,
          modificationSummary: completed.modificationSummary,
          beforeDigest: completed.beforeDigest,
          afterDigest: completed.afterDigest
        }
      };
      await this.store.writeMemoryUpdateProposal(appliedProposal);
      if (typeof this.projectRegistry.refreshProjectMemory === "function") await this.projectRegistry.refreshProjectMemory(projectId);
      return { proposal: appliedProposal, application: completed };
    } catch (error) {
      await this.store.writeMemoryApplication({ ...application, status: "failed", error: cleanOptionalText(error?.message, 2000), failedAt: nowIso() });
      throw error;
    }
  }
}
