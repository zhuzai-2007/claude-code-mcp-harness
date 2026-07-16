const checklistItems = [
  { title: "运行 Provider Preflight", area: "环境", complete: true },
  { title: "确认审批边界", area: "安全", complete: true },
  { title: "完成真实 Workflow", area: "Dogfood", complete: false },
  { title: "检查发布基线", area: "Release", complete: false },
  { title: "记录当前限制", area: "文档", complete: false }
];

const state = { status: "all", keyword: "" };
const statusFilter = document.querySelector("#status-filter");
const keywordSearch = document.querySelector("#keyword-search");
const checklist = document.querySelector("#checklist");
const emptyState = document.querySelector("#empty-state");
const visibleCount = document.querySelector("#visible-count");
const completeCount = document.querySelector("#complete-count");

function visibleItems() {
  let items = checklistItems;
  if (state.status === "complete") items = items.filter((item) => item.complete);
  else if (state.status === "open") items = items.filter((item) => !item.complete);

  if (state.keyword) {
    const kw = state.keyword.toLowerCase();
    items = items.filter((item) =>
      item.title.toLowerCase().includes(kw) ||
      item.area.toLowerCase().includes(kw)
    );
  }

  return items;
}

function render() {
  const items = visibleItems();
  checklist.replaceChildren(...items.map((item) => {
    const row = document.createElement("li");
    row.className = item.complete ? "complete" : "";
    const title = document.createElement("strong");
    title.textContent = item.title;
    const area = document.createElement("span");
    area.textContent = `${item.area} · ${item.complete ? "已完成" : "待完成"}`;
    row.append(title, area);
    return row;
  }));
  visibleCount.textContent = String(items.length);
  completeCount.textContent = String(checklistItems.filter((item) => item.complete).length);
  emptyState.hidden = items.length > 0;
}

statusFilter.addEventListener("change", () => {
  state.status = statusFilter.value;
  render();
});

keywordSearch.addEventListener("input", () => {
  state.keyword = keywordSearch.value;
  render();
});

render();
