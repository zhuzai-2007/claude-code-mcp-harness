const todos = [
  { title: "Confirm release notes", detail: "Check user-facing changes and known limitations.", status: "open", priority: "high" },
  { title: "Run local smoke tests", detail: "Exercise the Harness, MCP bridge, Runtime, and Dashboard.", status: "complete", priority: "high" },
  { title: "Review onboarding copy", detail: "Follow clone, install, doctor, and start as a new user.", status: "open", priority: "medium" },
  { title: "Inspect ignored artifacts", detail: "Ensure local runtime history cannot enter the release.", status: "complete", priority: "medium" },
  { title: "Capture remaining risks", detail: "Record provider, platform, and release metadata constraints.", status: "open", priority: "low" }
];

const state = { status: "all" };
const list = document.querySelector("#todo-list");
const statusFilter = document.querySelector("#status-filter");
const visibleCount = document.querySelector("#visible-count");
const completeCount = document.querySelector("#complete-count");
const emptyState = document.querySelector("#empty-state");

function render() {
  const visible = todos.filter((todo) => state.status === "all" || todo.status === state.status);
  list.innerHTML = visible.map((todo) => `
    <li class="todo-card">
      <h2>${todo.title}</h2>
      <p>${todo.detail}</p>
      <div class="badges">
        <span class="badge priority-${todo.priority}">${todo.priority}</span>
        <span class="badge status-${todo.status}">${todo.status}</span>
      </div>
    </li>
  `).join("");
  visibleCount.textContent = String(visible.length);
  completeCount.textContent = String(visible.filter((todo) => todo.status === "complete").length);
  emptyState.hidden = visible.length !== 0;
}

statusFilter.addEventListener("change", (event) => {
  state.status = event.target.value;
  render();
});

render();
