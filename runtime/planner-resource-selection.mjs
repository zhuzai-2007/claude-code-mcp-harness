const TIERS = ["small", "medium", "large"];

function array(value) {
  return Array.isArray(value) ? value : [];
}

function normalizedText(value) {
  if (typeof value === "string") return value;
  try { return JSON.stringify(value); }
  catch { return String(value || ""); }
}

function changeFiles(change) {
  if (!change || typeof change !== "object") return [];
  const values = [change.file, change.path, change.target, ...array(change.files)];
  return values.filter((value) => typeof value === "string" && value.trim()).map((value) => value.trim().replaceAll("\\", "/"));
}

function changeOperation(change) {
  if (!change || typeof change !== "object") return "";
  return String(change.type || change.operation || change.action || "").trim().toLowerCase();
}

function tierIndex(tier) {
  const index = TIERS.indexOf(String(tier || "").toLowerCase());
  return index < 0 ? 0 : index;
}

function priorTier(supervisorDecision) {
  const complexity = String(supervisorDecision?.estimated_resources?.complexity || "").trim().toLowerCase();
  if (["large", "high", "complex"].includes(complexity)) return "large";
  if (["medium", "moderate"].includes(complexity)) return "medium";
  return "small";
}

function scopeTier(metrics) {
  if (metrics.uniqueFiles >= 8 || metrics.proposedChanges >= 8 || (metrics.destructiveChanges > 0 && metrics.uniqueFiles >= 4)) return "large";
  if (metrics.uniqueFiles >= 3 || metrics.proposedChanges >= 3 || metrics.createdFiles > 0 || metrics.detailItems >= 8 || metrics.risks >= 3) return "medium";
  return "small";
}

export function selectPlannerResourceProfile({ audit, policy, supervisorDecision = null, selectedAt = new Date().toISOString() } = {}) {
  if (!audit || policy?.strategy !== "planner_scope") return null;
  const tiers = policy.tiers || {};
  if (!TIERS.every((tier) => typeof tiers[tier] === "string" && tiers[tier].trim())) return null;

  const proposed = array(audit.proposed_changes);
  const files = new Set(proposed.flatMap(changeFiles));
  const operations = proposed.map(changeOperation);
  const metrics = {
    proposedChanges: proposed.length,
    uniqueFiles: files.size,
    createdFiles: operations.filter((operation) => /^(create|add|new)$/.test(operation)).length,
    destructiveChanges: operations.filter((operation) => /^(delete|remove|rename|move)$/.test(operation)).length,
    detailItems: proposed.reduce((total, change) => total + array(change?.details).length, 0),
    risks: array(audit.risks).length,
    blockers: array(audit.blocked_on).length
  };
  const plannerTier = scopeTier(metrics);
  const decisionTier = priorTier(supervisorDecision);
  const selectedTier = TIERS[Math.max(tierIndex(plannerTier), tierIndex(decisionTier))];
  const reasons = [
    `Planner proposed ${metrics.proposedChanges} change item(s) across ${metrics.uniqueFiles} explicit file(s).`,
    `Planner scope classified as ${plannerTier}.`,
    `Supervisor pre-plan estimate classified as ${decisionTier}.`
  ];
  if (metrics.createdFiles) reasons.push(`Plan creates ${metrics.createdFiles} file(s).`);
  if (metrics.destructiveChanges) reasons.push(`Plan includes ${metrics.destructiveChanges} destructive file operation(s).`);
  if (metrics.detailItems) reasons.push(`Plan contains ${metrics.detailItems} implementation detail item(s).`);

  return {
    schemaVersion: 1,
    source: "planner_audit",
    strategy: policy.strategy,
    tier: selectedTier,
    profile: tiers[selectedTier],
    defaultProfile: policy.defaultProfile || tiers.small,
    metrics,
    reasons,
    selectedAt,
    plannerSummary: String(audit.summary || "").trim() || null
  };
}
