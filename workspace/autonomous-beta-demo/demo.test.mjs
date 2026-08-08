import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

class FakeElement {
  constructor() {
    this.children = [];
    this.className = "";
    this.hidden = false;
    this.listeners = new Map();
    this.textContent = "";
    this.value = "";
  }

  addEventListener(type, listener) { this.listeners.set(type, listener); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  dispatch(type) { this.listeners.get(type)?.(); }
}

const elements = Object.fromEntries(["status-filter", "keyword-search", "checklist", "empty-state", "visible-count", "complete-count"].map((id) => [id, new FakeElement()]));
elements["status-filter"].value = "all";

const document = {
  querySelector(selector) { return elements[selector.slice(1)] || null; },
  createElement() { return new FakeElement(); }
};

const source = await readFile(new URL("./app.js", import.meta.url), "utf8");
vm.runInNewContext(source, { document }, { filename: "app.js" });

function snapshot() {
  return {
    visible: elements["visible-count"].textContent,
    complete: elements["complete-count"].textContent,
    rows: elements.checklist.children.length,
    empty: !elements["empty-state"].hidden
  };
}

assert.deepEqual(snapshot(), { visible: "5", complete: "2", rows: 5, empty: false });

elements["keyword-search"].value = "Release";
elements["keyword-search"].dispatch("input");
assert.deepEqual(snapshot(), { visible: "1", complete: "2", rows: 1, empty: false });

elements["status-filter"].value = "open";
elements["status-filter"].dispatch("change");
assert.deepEqual(snapshot(), { visible: "1", complete: "2", rows: 1, empty: false });

elements["keyword-search"].value = "安全";
elements["keyword-search"].dispatch("input");
assert.deepEqual(snapshot(), { visible: "0", complete: "2", rows: 0, empty: true });

elements["status-filter"].value = "all";
elements["status-filter"].dispatch("change");
assert.deepEqual(snapshot(), { visible: "1", complete: "2", rows: 1, empty: false });

const [html, css] = await Promise.all([
  readFile(new URL("./index.html", import.meta.url), "utf8"),
  readFile(new URL("./styles.css", import.meta.url), "utf8")
]);
assert.match(html, /id="keyword-search"/);
assert.match(css, /@media \(max-width: 600px\)/);
assert.match(css, /grid-template-columns:\s*auto 1fr/);
assert.match(css, /min-width:\s*0/);

console.log(JSON.stringify({ ok: true, initialRows: 5, keywordRows: 1, combinedRows: 1, emptyState: true, mobileContract: true }, null, 2));
