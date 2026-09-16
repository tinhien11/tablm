import CDP from 'chrome-remote-interface';
const targets = await (await fetch("http://127.0.0.1:9222/json")).json();
const ds = targets.find(t => t.url.includes("chat.deepseek.com"));
if (!ds) { console.log("no deepseek tab"); process.exit(1); }
const client = await CDP({ target: ds });
const { Runtime } = client;
await Runtime.enable();
const evalJs = async (expr) =>
  (await Runtime.evaluate({ expression: expr, returnByValue: true, awaitPromise: true })).result.value;
const out = {};
out.msgClasses = await evalJs(`JSON.stringify([...document.querySelectorAll(".ds-message")].map(e=>String(e.className)),null,1)`);
out.msgParents = await evalJs(`JSON.stringify([...document.querySelectorAll(".ds-message")].map(e=>({p:String(e.parentElement.className).slice(0,80)})),null,1)`);
out.sendBtn = await evalJs(`JSON.stringify([...document.querySelectorAll("div[role=button]")].filter(e=>/ds-button--primary/.test(e.className)).map(e=>({cls:String(e.className).slice(0,140),aria:e.getAttribute("aria-label")})),null,1)`);
out.placeholder = await evalJs(`JSON.stringify([...document.querySelectorAll("textarea")].map(e=>e.placeholder))`);
console.log(JSON.stringify(out, null, 2));
await client.close();
