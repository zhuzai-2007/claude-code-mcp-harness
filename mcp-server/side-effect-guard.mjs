import { readdir, readlink, lstat } from "node:fs/promises";
import path from "node:path";

const ignoredRoots = new Set([".git", "node_modules", "mcp-server/node_modules", ".agent-runs", ".agents/runs"]);

function normalize(relativePath) {
  return relativePath.split(path.sep).join("/");
}

function isIgnored(relativePath) {
  const normalized = normalize(relativePath);
  for (const ignored of ignoredRoots) {
    if (normalized === ignored || normalized.startsWith(`${ignored}/`)) return true;
  }
  return false;
}

export async function snapshotTree(root) {
  const directories = new Set();
  const files = new Map();
  const symbolicLinks = new Map();

  async function visit(relativeDirectory) {
    const absoluteDirectory = path.join(root, relativeDirectory);
    const entries = await readdir(absoluteDirectory, { withFileTypes: true });
    for (const entry of entries) {
      const relativePath = normalize(path.join(relativeDirectory, entry.name));
      if (isIgnored(relativePath)) continue;
      const absolutePath = path.join(root, relativePath);
      if (entry.isSymbolicLink()) {
        symbolicLinks.set(relativePath, await readlink(absolutePath));
      } else if (entry.isDirectory()) {
        directories.add(relativePath);
        await visit(relativePath);
      } else if (entry.isFile()) {
        const stat = await lstat(absolutePath, { bigint: true });
        files.set(relativePath, { size: String(stat.size), mtimeNs: String(stat.mtimeNs) });
      }
    }
  }

  await visit("");
  return { directories, files, symbolicLinks };
}

export function diffSnapshots(before, after, { allowedFiles = [], allowedDirectories = [] } = {}) {
  const allowedFileSet = new Set(allowedFiles.map(normalize));
  const allowedDirectorySet = new Set(allowedDirectories.map(normalize));
  const unexpected = {
    newDirectories: [],
    newFiles: [],
    changedFiles: [],
    deletedFiles: [],
    deletedDirectories: [],
    newSymbolicLinks: [],
    changedSymbolicLinks: [],
    deletedSymbolicLinks: []
  };

  for (const directory of after.directories) {
    if (!before.directories.has(directory) && !allowedDirectorySet.has(directory)) unexpected.newDirectories.push(directory);
  }
  for (const directory of before.directories) {
    if (!after.directories.has(directory) && !allowedDirectorySet.has(directory)) unexpected.deletedDirectories.push(directory);
  }
  for (const [file, metadata] of after.files) {
    if (!before.files.has(file)) {
      if (!allowedFileSet.has(file)) unexpected.newFiles.push(file);
    } else {
      const previous = before.files.get(file);
      if ((previous.size !== metadata.size || previous.mtimeNs !== metadata.mtimeNs) && !allowedFileSet.has(file)) {
        unexpected.changedFiles.push(file);
      }
    }
  }
  for (const file of before.files.keys()) {
    if (!after.files.has(file) && !allowedFileSet.has(file)) unexpected.deletedFiles.push(file);
  }
  for (const [link, target] of after.symbolicLinks) {
    if (!before.symbolicLinks.has(link)) unexpected.newSymbolicLinks.push(link);
    else if (before.symbolicLinks.get(link) !== target) unexpected.changedSymbolicLinks.push(link);
  }
  for (const link of before.symbolicLinks.keys()) {
    if (!after.symbolicLinks.has(link)) unexpected.deletedSymbolicLinks.push(link);
  }

  for (const values of Object.values(unexpected)) values.sort();
  return unexpected;
}

export function hasUnexpectedSideEffects(diff) {
  return Object.values(diff).some((values) => values.length > 0);
}
