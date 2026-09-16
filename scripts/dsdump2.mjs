import CDP from 'chrome-remote-interface';
const targets = await (await fetch("http://127.0.0.1:9222/json")).json();
const ds = targets.find(t => t.url.includes("chat.deepseek.com"));
if (!ds) { console.log("no deepseek tab"); process.exit(1); }
const client = await CDP({ target: ds });
const { Runtime } = client;
await Runtime.enable();
const evalJs = async (expr) =>
  (await Runtime.evaluate({ expression: expr, returnByValue: true, awaitPromise: true })).result.value;
const probes = {
  markdownBlocks: `document.querySelectorAll(".ds-markdown").length`,
  mdSample: `JSON.stringify([...document.querySelectorAll(".ds-markdown")].slice(-3).map(e=>({cls:e.className, txt:(e.innerText||"").slice(0,60)})),null,1)`,
  containers: `JSON.stringify([...document.querySelectorAll("div")].filter(e=>/message|chat-item|request|answer|group/i.test(e.className)&&e.offsetWidth).slice(0,12).map(e=>({cls:String(e.className).slice(0,90), txt:(e.innerText||"").slice(0,40)})),null,1)`,
  labeled: `JSON.stringify([...document.querySelectorAll("div[role=button], button")].map(e=>({label:e.getAttribute("aria-label")||"", txt:(e.innerText||"").slice(0,30)})).filter(x=>x.label||x.txt).slice(0,12),null,1)`,
  path: `location.pathname`,
};
const out = {};
for (const [k, expr] of Object.entries(probes)) out[k] = await evalJs(expr);
console.log(JSON.stringify(out, null, 2));
await client.close();
