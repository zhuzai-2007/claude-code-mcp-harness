import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, "app.js"), "utf8");
const html = fs.readFileSync(path.join(here, "index.html"), "utf8");
const css = fs.readFileSync(path.join(here, "styles.css"), "utf8");

function element() {
  return { innerHTML: "", textContent: "", hidden: false, listeners: {}, addEventListener(type, handler) { this.listeners[type] = handler; } };
}

const elements = new Map([
  ["#todo-list", element()],
  ["#status-filter", element()],
  ["#visible-count", element()],
  ["#complete-count", element()],
  ["#empty-state", element()]
]);

vm.runInNewContext(source, { document: { querySelector(selector) { return elements.get(selector); } } });
assert.equal(elements.get("#visible-count").textContent, "5");
assert.equal(elements.get("#complete-count").textContent, "2");
elements.get("#status-filter").listeners.change({ target: { value: "open" } });
assert.equal(elements.get("#visible-count").textContent, "3");
assert.equal(elements.get("#complete-count").textContent, "0");
assert.match(elements.get("#todo-list").innerHTML, /priority-high/);
assert.match(html, /id="status-filter"/);
assert.doesNotMatch(html, /id="priority-filter"/);
assert.match(css, /@media \(max-width: 560px\)/);

console.log(JSON.stringify({ ok: true, contract: "release todo contract", baseline: "status filtering only", todos: 5 }, null, 2));
