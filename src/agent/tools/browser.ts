import { writeFileSync } from "node:fs";
import { openTab, Page as CdpPage, ensureChrome } from "../../transport/cdp.js";
import type { Tool } from "./index.js";

// One scratch tab per CLI process, reused for every browser tool call.
let scratchPage: CdpPage | null = null;

async function getScratchPage(url: string): Promise<CdpPage> {
  if (scratchPage) {
    try {
      await scratchPage.evalValue("1");
      await scratchPage.navigate(url);
      return scratchPage;
    } catch {
      try {
        await scratchPage.close();
      } catch {}
      scratchPage = null;
    }
  }
  await ensureChrome();
  const target = await openTab(url);
  scratchPage = await CdpPage.attach(target);
  await scratchPage.navigate(url);
  return scratchPage;
}

export async function closeScratchPage(): Promise<void> {
  if (scratchPage) {
    try {
      await scratchPage.close();
    } catch {}
    scratchPage = null;
  }
}

function needPage(): CdpPage | null {
  return scratchPage;
}

export const browserNavigate: Tool = {
  name: "BrowserNavigate",
  description: "Navigate the browser tab to a URL. Returns the page title and URL after load.",
  input_schema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
  run: async (input) => {
    try {
      const page = await getScratchPage(input.url);
      await new Promise((r) => setTimeout(r, 2000));
      return await page.evalValue<string>("JSON.stringify({ url: location.href, title: document.title })");
    } catch (e: any) {
      return `[error] navigate failed: ${e.message}`;
    }
  },
};

export const browserSnapshot: Tool = {
  name: "BrowserSnapshot",
  description:
    "Get a text snapshot of the current page: visible text plus interactive elements with selectors. Use after BrowserNavigate.",
  input_schema: { type: "object", properties: { selector: { type: "string" } }, required: [] },
  run: async (input) => {
    const page = needPage();
    if (!page) return "[error] no page open - use BrowserNavigate first";
    try {
      const sel = JSON.stringify(input.selector || "body");
      return await page.evalValue<string>(
        `(() => {
          const root = document.querySelector(${sel}) || document.body;
          const lines = [];
          lines.push("=== TEXT ===");
          lines.push(root.innerText.slice(0, 5000));
          lines.push("\\n=== INTERACTIVE ELEMENTS ===");
          const els = root.querySelectorAll('a, button, input, textarea, select, [role="button"], [onclick]');
          let count = 0;
          for (const el of els) {
            if (count >= 100) { lines.push("... (truncated)"); break; }
            const tag = el.tagName.toLowerCase();
            const id = el.id ? '#' + el.id : '';
            const cls = el.className && typeof el.className === 'string' ? '.' + el.className.split(' ').filter(Boolean).slice(0, 3).join('.') : '';
            const text2 = (el.innerText || el.value || el.getAttribute('placeholder') || el.getAttribute('aria-label') || '').trim().slice(0, 60);
            lines.push(count + ': ' + tag + id + cls + ' -> "' + text2 + '"');
            count++;
          }
          return lines.join('\\n');
        })()`
      );
    } catch (e: any) {
      return `[error] snapshot failed: ${e.message}`;
    }
  },
};

export const browserClick: Tool = {
  name: "BrowserClick",
  description: "Click an element on the page by CSS selector. Use after BrowserSnapshot to find the selector.",
  input_schema: { type: "object", properties: { selector: { type: "string" } }, required: ["selector"] },
  run: async (input) => {
    const page = needPage();
    if (!page) return "[error] no page open - use BrowserNavigate first";
    const safe = JSON.stringify(input.selector);
    try {
      const result = await page.evalValue<string>(
        `(() => {
          const el = document.querySelector(${safe});
          if (!el) return '[error] element not found: ' + ${safe};
          el.click();
          return 'clicked: ' + ${safe};
        })()`
      );
      await new Promise((r) => setTimeout(r, 1000));
      return result;
    } catch (e: any) {
      return `[error] click failed: ${e.message}`;
    }
  },
};

export const browserFill: Tool = {
  name: "BrowserFill",
  description: "Type text into an input or textarea by CSS selector.",
  input_schema: {
    type: "object",
    properties: { selector: { type: "string" }, value: { type: "string" } },
    required: ["selector", "value"],
  },
  run: async (input) => {
    const page = needPage();
    if (!page) return "[error] no page open - use BrowserNavigate first";
    const safe = JSON.stringify(input.selector);
    const val = JSON.stringify(input.value);
    try {
      return await page.evalValue<string>(
        `(() => {
          const el = document.querySelector(${safe});
          if (!el) return '[error] element not found: ' + ${safe};
          const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          const nativeTextAreaValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
          const setter = el.tagName === 'TEXTAREA' ? nativeTextAreaValueSetter : nativeInputValueSetter;
          if (setter) setter.call(el, ${val});
          else el.value = ${val};
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return 'filled: ' + ${safe} + ' with ' + ${input.value.length} + ' chars';
        })()`
      );
    } catch (e: any) {
      return `[error] fill failed: ${e.message}`;
    }
  },
};

export const browserScreenshot: Tool = {
  name: "BrowserScreenshot",
  description: "Take a screenshot of the current page and save it to a file. Returns the file path.",
  input_schema: { type: "object", properties: { path: { type: "string" } }, required: [] },
  run: async (input) => {
    const page = needPage();
    if (!page) return "[error] no page open - use BrowserNavigate first";
    try {
      const data = await page.screenshot();
      const filePath = input.path || "/tmp/tablm-screenshot.png";
      writeFileSync(filePath, Buffer.from(data, "base64"));
      return `screenshot saved to ${filePath} (${Math.round((data.length * 3) / 4 / 1024)}KB)`;
    } catch (e: any) {
      return `[error] screenshot failed: ${e.message}`;
    }
  },
};

export const browserEval: Tool = {
  name: "BrowserEval",
  description: "Evaluate JavaScript on the current page and return the result.",
  input_schema: { type: "object", properties: { code: { type: "string" } }, required: ["code"] },
  run: async (input) => {
    const page = needPage();
    if (!page) return "[error] no page open - use BrowserNavigate first";
    try {
      const result = await page.evalValue<string>(input.code);
      return typeof result === "string" ? result : JSON.stringify(result);
    } catch (e: any) {
      return `[error] eval failed: ${e.message}`;
    }
  },
};
