import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const DECISION_ID_PATTERN = /^decision_[a-zA-Z0-9_-]+$/;
const SESSION_ID_PATTERN = /^session_[a-zA-Z0-9_-]+$/;
const WORKFLOW_ID_PATTERN = /^workflow_[a-zA-Z0-9_-]+$/;
const PROJECT_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const REVIEW_ID_PATTERN = /^supervisor_review_[a-zA-Z0-9_-]+$/;
const APPLICATION_ID_PATTERN = /^memory_apply_[a-zA-Z0-9_-]+$/;

async function writeJsonAtomic(filePath, value) {
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
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

export class FileSupervisorStore {
  constructor(dataRoot) {
    this.dataRoot = path.resolve(dataRoot);
    this.decisionsRoot = path.join(this.dataRoot, "supervisor-decisions");
    this.sessionsRoot = path.join(this.dataRoot, "project-sessions");
    this.reviewPackagesRoot = path.join(this.dataRoot, "supervisor-review-packages");
    this.memoryProposalsRoot = path.join(this.dataRoot, "memory-update-proposals");
    this.reviewResultsRoot = path.join(this.dataRoot, "supervisor-review-results");
    this.memoryApplicationsRoot = path.join(this.dataRoot, "memory-application-history");
    this.projectBriefsRoot = path.join(this.dataRoot, "project-briefs");
    this.projectUsagePath = path.join(this.dataRoot, "project-usage.json");
  }

  async init() { await Promise.all([mkdir(this.decisionsRoot, { recursive: true }), mkdir(this.sessionsRoot, { recursive: true }), mkdir(this.reviewPackagesRoot, { recursive: true }), mkdir(this.memoryProposalsRoot, { recursive: true }), mkdir(this.reviewResultsRoot, { recursive: true }), mkdir(this.memoryApplicationsRoot, { recursive: true }), mkdir(this.projectBriefsRoot, { recursive: true })]); }

  projectBriefPath(projectId) {
    if (!PROJECT_ID_PATTERN.test(String(projectId || ""))) throw new Error(`Invalid projectId: ${projectId}`);
    return path.join(this.projectBriefsRoot, `${projectId}.json`);
  }

  async writeProjectBrief(brief) {
    await this.init();
    await writeJsonAtomic(this.projectBriefPath(brief.projectId), brief);
    return brief;
  }

  async readProjectBrief(projectId) {
    try { return JSON.parse(await readFile(this.projectBriefPath(projectId), "utf8")); }
    catch (error) { if (error?.code === "ENOENT") return null; throw error; }
  }

  reviewResultsPath(workflowId) {
    if (!WORKFLOW_ID_PATTERN.test(String(workflowId || ""))) throw new Error(`Invalid workflowId: ${workflowId}`);
    return path.join(this.reviewResultsRoot, workflowId);
  }

  async writeSupervisorReviewResult(result) {
    if (!REVIEW_ID_PATTERN.test(String(result?.reviewId || ""))) throw new Error(`Invalid reviewId: ${result?.reviewId}`);
    const directory = this.reviewResultsPath(result.workflowId);
    await mkdir(directory, { recursive: true });
    await writeJsonAtomic(path.join(directory, `${result.reviewId}.json`), result);
    return result;
  }

  async listSupervisorReviewResults(workflowId) {
    const directory = this.reviewResultsPath(workflowId);
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) { if (error?.code === "ENOENT") return []; throw error; }
    const results = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const reviewId = entry.name.slice(0, -5);
      if (!REVIEW_ID_PATTERN.test(reviewId)) continue;
      results.push(JSON.parse(await readFile(path.join(directory, entry.name), "utf8")));
    }
    return results.sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)) || String(right.reviewId).localeCompare(String(left.reviewId)));
  }

  memoryApplicationPath(projectId, applicationId) {
    if (!PROJECT_ID_PATTERN.test(String(projectId || ""))) throw new Error(`Invalid projectId: ${projectId}`);
    if (!APPLICATION_ID_PATTERN.test(String(applicationId || ""))) throw new Error(`Invalid applicationId: ${applicationId}`);
    return path.join(this.memoryApplicationsRoot, projectId, `${applicationId}.json`);
  }

  async writeMemoryApplication(application) {
    const filePath = this.memoryApplicationPath(application.projectId, application.applicationId);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeJsonAtomic(filePath, application);
    return application;
  }

  async listMemoryApplications({ projectId, workflowId = null } = {}) {
    if (!PROJECT_ID_PATTERN.test(String(projectId || ""))) throw new Error(`Invalid projectId: ${projectId}`);
    const directory = path.join(this.memoryApplicationsRoot, projectId);
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) { if (error?.code === "ENOENT") return []; throw error; }
    const applications = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const applicationId = entry.name.slice(0, -5);
      if (!APPLICATION_ID_PATTERN.test(applicationId)) continue;
      const application = JSON.parse(await readFile(path.join(directory, entry.name), "utf8"));
      if (!workflowId || application.workflowId === workflowId) applications.push(application);
    }
    return applications.sort((left, right) => String(right.appliedAt || right.createdAt).localeCompare(String(left.appliedAt || left.createdAt)));
  }

  reviewPackagePath(workflowId) {
    if (!WORKFLOW_ID_PATTERN.test(String(workflowId || ""))) throw new Error(`Invalid workflowId: ${workflowId}`);
    return path.join(this.reviewPackagesRoot, `${workflowId}.json`);
  }

  async writeReviewPackage(reviewPackage) {
    await this.init();
    await writeJsonAtomic(this.reviewPackagePath(reviewPackage.workflowId), reviewPackage);
    return reviewPackage;
  }

  async readReviewPackage(workflowId) {
    try { return JSON.parse(await readFile(this.reviewPackagePath(workflowId), "utf8")); }
    catch (error) { if (error?.code === "ENOENT") return null; throw error; }
  }

  memoryProposalPath(workflowId) {
    if (!WORKFLOW_ID_PATTERN.test(String(workflowId || ""))) throw new Error(`Invalid workflowId: ${workflowId}`);
    return path.join(this.memoryProposalsRoot, `${workflowId}.json`);
  }

  async writeMemoryUpdateProposal(proposal) {
    await this.init();
    await writeJsonAtomic(this.memoryProposalPath(proposal.workflowId), proposal);
    return proposal;
  }

  async readMemoryUpdateProposal(workflowId) {
    try { return JSON.parse(await readFile(this.memoryProposalPath(workflowId), "utf8")); }
    catch (error) { if (error?.code === "ENOENT") return null; throw error; }
  }

  sessionPath(sessionId) {
    if (!SESSION_ID_PATTERN.test(String(sessionId || ""))) throw new Error(`Invalid sessionId: ${sessionId}`);
    return path.join(this.sessionsRoot, `${sessionId}.json`);
  }

  async createSession({ projectId, name, source = "supervisor", purpose = null, decisions = [], unresolvedQuestions = [], nextActions = [] }) {
    const createdAt = new Date().toISOString();
    const session = {
      schemaVersion: 2,
      sessionId: `session_${Date.now().toString(36)}_${randomBytes(6).toString("hex")}`,
      projectId: String(projectId || "").trim(),
      name: String(name || "Project session").trim().slice(0, 120) || "Project session",
      source: String(source || "supervisor"),
      workflowIds: [],
      purpose: String(purpose || name || "Project session").trim().slice(0, 2000) || "Project session",
      decisions: Array.isArray(decisions) ? decisions.map(String).map((item) => item.trim()).filter(Boolean).slice(0, 50) : [],
      unresolvedQuestions: Array.isArray(unresolvedQuestions) ? unresolvedQuestions.map(String).map((item) => item.trim()).filter(Boolean).slice(0, 50) : [],
      nextActions: Array.isArray(nextActions) ? nextActions.map(String).map((item) => item.trim()).filter(Boolean).slice(0, 50) : [],
      relatedWorkflows: [],
      createdAt,
      updatedAt: createdAt
    };
    if (!session.projectId) throw new Error("projectId is required to create a Project Session.");
    await writeJsonAtomic(this.sessionPath(session.sessionId), session);
    return session;
  }

  async readSession(sessionId) {
    try {
      const session = JSON.parse(await readFile(this.sessionPath(sessionId), "utf8"));
      const workflowIds = [...new Set([...(session.workflowIds || []), ...(session.relatedWorkflows || [])])];
      return {
        ...session,
        purpose: String(session.purpose || session.name || "Project session"),
        decisions: Array.isArray(session.decisions) ? session.decisions : [],
        unresolvedQuestions: Array.isArray(session.unresolvedQuestions) ? session.unresolvedQuestions : [],
        nextActions: Array.isArray(session.nextActions) ? session.nextActions : [],
        workflowIds,
        relatedWorkflows: workflowIds
      };
    }
    catch (error) { if (error?.code === "ENOENT") return null; throw error; }
  }

  async listSessions({ projectId = null, limit = 200 } = {}) {
    await this.init();
    const sessions = [];
    for (const entry of await readdir(this.sessionsRoot, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const session = await this.readSession(entry.name.slice(0, -5));
      if (session && (!projectId || session.projectId === projectId)) sessions.push(session);
    }
    return sessions.sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt))).slice(0, Math.max(1, Number(limit) || 200));
  }

  async requireSession(sessionId, projectId) {
    const session = await this.readSession(sessionId);
    if (!session) throw new Error(`Project Session not found: ${sessionId}`);
    if (session.projectId !== projectId) throw new Error(`Project Session '${sessionId}' belongs to project '${session.projectId}', not '${projectId}'.`);
    return session;
  }

  async attachWorkflowToSession(sessionId, workflowId) {
    const session = await this.readSession(sessionId);
    if (!session) throw new Error(`Project Session not found: ${sessionId}`);
    session.workflowIds = [...new Set([...(session.workflowIds || []), workflowId])];
    session.relatedWorkflows = [...session.workflowIds];
    session.schemaVersion = Math.max(2, Number(session.schemaVersion || 1));
    session.updatedAt = new Date().toISOString();
    await writeJsonAtomic(this.sessionPath(sessionId), session);
    return session;
  }

  decisionPath(decisionId) {
    if (!DECISION_ID_PATTERN.test(String(decisionId || ""))) throw new Error(`Invalid decisionId: ${decisionId}`);
    return path.join(this.decisionsRoot, `${decisionId}.json`);
  }

  async writeDecision(decision) {
    await this.init();
    await writeJsonAtomic(this.decisionPath(decision.decisionId), decision);
    return decision;
  }

  async readDecision(decisionId) {
    try { return JSON.parse(await readFile(this.decisionPath(decisionId), "utf8")); }
    catch (error) { if (error?.code === "ENOENT") return null; throw error; }
  }

  async listDecisions({ limit = 100 } = {}) {
    await this.init();
    const decisions = [];
    for (const entry of await readdir(this.decisionsRoot, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const decision = await this.readDecision(entry.name.slice(0, -5));
      if (decision) decisions.push(decision);
    }
    return decisions.sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt))).slice(0, Math.max(1, Number(limit) || 100));
  }

  async readProjectUsage() {
    try { return JSON.parse(await readFile(this.projectUsagePath, "utf8")); }
    catch (error) { if (error?.code === "ENOENT") return {}; throw error; }
  }

  async markProjectUsed(projectId, timestamp = new Date().toISOString()) {
    const usage = await this.readProjectUsage();
    usage[projectId] = timestamp;
    await writeJsonAtomic(this.projectUsagePath, usage);
    return timestamp;
  }
}
