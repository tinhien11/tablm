import CDP from 'chrome-remote-interface';
const targets = await (await fetch('http://127.0.0.1:9222/json')).json();
const ds = targets.find(t => t.url.includes('chat.deepseek.com'));
if (!ds) { console.log('no deepseek tab'); process.exit(1); }
const client = await CDP({ target: ds });
const { Runtime } = client;
await Runtime.enable();
const evalJs = async (expr) => {
  const r = await Runtime.evaluate({ expression: expr, returnByValue: true, awaitPromise: true });
  return r.result.value;
};
const out = {};
out.url = ds.url;
out.buttons = await evalJs(`JSON.stringify([...document.querySelectorAll('textarea, [contenteditable="true"], button, div[role="button"]')].filter(e=>e.offsetWidth||e.offsetHeight).slice(0,60).map(e=>({tag:e.tagName, id:e.id||null, cls:(e.className&&String(e.className).slice(0,120))||null, txt:(e.innerText||e.getAttribute('aria-label')||e.placeholder||'').slice(0,60), role:e.getAttribute('role')})), null, 1)`);
console.log(JSON.stringify(out, null, 2));
await client.close();
