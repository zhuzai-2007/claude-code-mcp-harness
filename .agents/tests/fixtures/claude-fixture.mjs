const worker = {
  summary: "编码检查：“中文”—OK",
  files_read: ["README.md"],
  changes_made: [],
  commands_run: ["fixture native stdout"],
  tests_or_checks: ["UTF-8 round trip"],
  risks: [],
  blocked_on: []
};

process.stdout.write(`${JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: false,
  result: JSON.stringify(worker),
  total_cost_usd: 0
})}\n`);
