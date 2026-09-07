// Executes the dashboard's script against a stub DOM and asserts real content renders.
// This is the check that catches a blank page; static scanning of JS was not reliable.
import { readFileSync } from 'node:fs';

const html = readFileSync(process.argv[2], 'utf8');
const script = html.slice(html.lastIndexOf('<script>') + 8, html.lastIndexOf('</script>'));

const el = (id) => ({
  id, innerHTML: '', textContent: '', disabled: false, dataset: {},
  addEventListener() {}, scrollIntoView() {}, removeAttribute() {}, setAttribute() {},
});
const nodes = new Map();
const store = new Map();
const doc = {
  documentElement: { removeAttribute() {}, setAttribute() {} },
  getElementById(id) { if (!nodes.has(id)) nodes.set(id, el(id)); return nodes.get(id); },
  querySelectorAll() { return []; },
};
const sandbox = {
  document: doc,
  localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) },
  navigator: { clipboard: { writeText: async () => {} } },
  location: { reload() {} },
  confirm: () => false,
  fetch: async () => ({ ok: true, json: async () => ({ ok: true }) }),
  console,
};

try {
  new Function(...Object.keys(sandbox), script)(...Object.values(sandbox));
} catch (e) {
  console.error(`RUNTIME ERROR: ${e.message}`);
  process.exit(1);
}

const main = nodes.get('main');
if (!main || !main.innerHTML) { console.error('BLANK: #main received no content'); process.exit(1); }
const rail = nodes.get('rail');
if (!rail || !rail.innerHTML) { console.error('BLANK: #rail received no content'); process.exit(1); }

// A notebook with no notes still has to render, so assert its empty state instead
// of item markup it cannot have. The caller knows the count and passes --empty.
const checks = process.argv.includes('--empty')
  ? [['empty state rendered', /class="hint"/.test(main.innerHTML)]]
  : [
      ['item title rendered', /class="name"/.test(main.innerHTML)],
      ['action bar rendered', /Copy context/.test(main.innerHTML)],
      ['note body rendered', /class="md"|class="sheet"/.test(main.innerHTML)],
      ['sidebar has items', /class="pick"/.test(rail.innerHTML)],
    ];
let bad = 0;
for (const [name, ok] of checks) { console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}`); if (!ok) bad++; }
console.log(`  #main ${main.innerHTML.length} chars, #rail ${rail.innerHTML.length} chars`);
process.exit(bad ? 1 : 0);
