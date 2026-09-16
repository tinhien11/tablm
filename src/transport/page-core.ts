export interface TurnResult {
  status: "done" | "timeout" | "error";
  text: string;
  conversationId: string | null;
  thinking?: string;
  error?: string;
  diag?: Record<string, unknown>;
}

export async function pageTurn(cfg: any): Promise<TurnResult> {
  const S = cfg.selectors;
  const all = (sel: string, root?: Element): Element[] => {
    try {
      return [...(root || document).querySelectorAll(sel)];
    } catch {
      return [];
    }
  };
  const visible = (el: any): boolean =>
    !!(
      el &&
      (el.offsetWidth || el.offsetHeight || el.getClientRects().length) &&
      !el.disabled
    );
  const firstVisible = (sels: string[], root?: Element): Element | null => {
    for (const s of sels) {
      for (const el of all(s, root)) if (visible(el)) return el;
    }
    return null;
  };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  // Chat UIs inject accessibility headers ("ChatGPT said:", "You said:") into
  // the message container. Stripped so a header-only capture (response still
  // streaming) reads as EMPTY - the done-check then keeps waiting for real
  // content instead of ending the turn with 13 chars of UI chrome.
  // Known chat-provider outage/error boxes. These must NEVER be captured as a
  // model response - they read as empty so the poll keeps waiting (or times
  // out into the CLI's empty-retry path) instead of ending the turn.
  const OUTAGE = /chatgpt is temporarily|we'?re working to restore service|something went wrong|seems to have gone wrong|server had an error while processing|unable to load (conversation|site)/i;
  const stripUiArtifacts = (t: string): string =>
    t
      .replace(/^[ \t]*(?:#{1,6} )?(?:\*\*)?(?:ChatGPT|You|GLM|Z\.ai|Kimi|DeepSeek|Assistant) said:?(?:\*\*)?[ \t]*$/gim, "")
      // code-block header buttons rendered inside the message container
      .replace(/^[ \t]*(?:Copy|Download|Regenerate|Share|Edit)[ \t]*$/gim, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  const readMessage = (el: Element): string => {
    const extract = (): string => {
      for (const s of S.assistantContent || []) {
        const parts = all(s, el).filter(
          (n: any, _i: number, arr: any[]) => !arr.some((o: any) => o !== n && o.contains(n))
        );
        if (parts.length) {
          return stripUiArtifacts(
            parts
              .map((p: any) => p.innerText || "")
              .join("\n")
              .trim()
          );
        }
      }
      return stripUiArtifacts(((el as HTMLElement).innerText || el.textContent || "").trim());
    };
    const text = extract();
    return OUTAGE.test(text) ? "" : text; // outage box != a response
  };
  const composer = () => firstVisible(S.composer);
  const sendBtn = () => firstVisible(S.send);
  const stopBtn = () => firstVisible(S.stop);
  const isPlaceholder = (t: string): boolean => {
    if (!S.placeholderTexts || !t) return false;
    const trimmed = t.trim();
    return S.placeholderTexts.some((p: string) => new RegExp(p, "i").test(trimmed));
  };
  const generating = (): boolean => {
    if (stopBtn()) return true;
    for (const s of S.generating) {
      if (all(s).length) return true;
    }
    if (S.generatingAbsent) {
      for (const s of S.generatingAbsent) {
        if (!all(s).length) return true;
      }
    }
    return false;
  };
  const messageNodes = (): Element[] => {
    let sels: string[] = S.assistant || [];
    let nodes = sels.flatMap((s) => all(s));
    if (!nodes.length && (S.turns || []).length) {
      nodes = (S.turns as string[]).flatMap((s) => all(s));
    }
    const uniq = [...new Set(nodes)];
    return uniq.sort((a, b) =>
      a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
    );
  };
  const convId = (): string | null => {
    const m = location.pathname.match(new RegExp(S.conversationIdPattern));
    return m ? m[1] || m[0] : null;
  };
  const setComposer = (el: any, value: string): void => {
    el.focus();
    const tag = el.tagName.toLowerCase();
    if (tag === "textarea" || tag === "input") {
      const proto = tag === "textarea" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const d = Object.getOwnPropertyDescriptor(proto, "value");
      if (d && d.set) d.set.call(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return;
    }
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    if (sel) {
      sel.removeAllRanges();
      sel.addRange(range);
    }
    document.execCommand("insertText", false, value);
  };

  const startedAt = Date.now();
  const deadline = startedAt + cfg.timeoutMs;

  let comp: Element | null = null;
  while (Date.now() < deadline) {
    comp = composer();
    if (comp) break;
    await sleep(300);
  }
  if (!comp) {
    return {
      status: "error",
      text: "",
      conversationId: null,
      error:
        "composer not found on " +
        location.host +
        " (not signed in, or selectors need updating — try inspect_dom)",
    };
  }

  // Only the newest few messages matter for detecting the response. Reading
  // every node's innerText each poll is O(conversation size) of forced layout
  // - on long chats that froze the visible page.
  const READ_WINDOW = 8;
  const baseline = messageNodes().slice(-READ_WINDOW).map(readMessage);

  let userTouched = false;
  const noteUserInput = (e: Event) => {
    if (e.isTrusted) userTouched = true;
  };
  const releaseWatch = () => {
    for (const name of ["keydown", "paste", "input"]) {
      try {
        comp!.removeEventListener(name, noteUserInput, true);
      } catch {}
    }
  };

  let send: Element | null = null;
  for (let attempt = 0; attempt < 6 && !send; attempt++) {
    const target = composer() || comp;
    setComposer(target, cfg.prompt);
    for (let t = 0; t < 5 && !send; t++) {
      send = sendBtn();
      if (send) break;
      await sleep(400);
    }
    if (!send) await sleep(500);
  }
  if (!send) {
    const target = composer() || comp;
    for (const type of ["keydown", "keypress", "keyup"]) {
      target.dispatchEvent(
        new KeyboardEvent(type, {
          key: "Enter",
          code: "Enter",
          keyCode: 13,
          which: 13,
          bubbles: true,
          cancelable: true,
        })
      );
    }
  }
  for (const name of ["keydown", "paste", "input"]) {
    try {
      comp!.addEventListener(name, noteUserInput, true);
    } catch {}
  }

  const submitted = (): boolean => {
    const c = composer();
    const cur = c ? ((c as any).value ?? (c as HTMLElement).innerText ?? "") : "";
    if (!cur.includes(String(cfg.prompt).slice(0, 32))) return true;
    if (generating()) return true;
    return messageNodes()
      .map(readMessage)
      .some((t, i) => Boolean(t) && (baseline[i] === undefined || baseline[i] !== t));
  };

  let accepted = false;
  for (let attempt = 0; attempt < 3 && !accepted; attempt++) {
    if (userTouched) {
      releaseWatch();
      return {
        status: "error",
        text: "",
        conversationId: null,
        error: "composer was edited by the user during automation; refusing to submit",
      };
    }
    const btn = attempt === 0 ? send : sendBtn();
    if (!btn) break;
    (btn as HTMLElement).click();
    for (let t = 0; t < 6; t++) {
      await sleep(500);
      if (submitted()) {
        accepted = true;
        break;
      }
    }
  }
  releaseWatch();
  if (!accepted) {
    return {
      status: "error",
      text: "",
      conversationId: null,
      error:
        "site did not accept the prompt (composer still holds it); selectors may need updating via inspect_dom",
    };
  }

  const readThinking = (): string | undefined => {
    if (!thinkingText) return undefined;
    const stripped = thinkingText.replace(/^\s*thought process\s*/i, "").trim();
    return stripped || undefined;
  };
  const lastThinkingEl = (): Element | null => {
    if (!S.thinkingContent) return null;
    for (const s of S.thinkingContent) {
      try {
        const els = all(s);
        if (els.length) return els[els.length - 1];
      } catch {}
    }
    return null;
  };
  const baselineThinkingEl = lastThinkingEl();
  let thinkingEl: Element | null = null;
  let thinkingText = "";

  let lastSeenText: string | null = null;
  let lastActivity = Date.now();
  let stableSince: number | null = null;
  let candidate = "";
  let candEl: Element | null = null;
  while (Date.now() < deadline) {
    const active = generating();
    const nodes = messageNodes().slice(-READ_WINDOW);
    const texts = nodes.map(readMessage);
    const fresh: { text: string; el: Element }[] = [];
    for (let i = 0; i < texts.length; i++) {
      const t = texts[i];
      if (t && !isPlaceholder(t) && (baseline[i] === undefined || baseline[i] !== t)) fresh.push({ text: t, el: nodes[i] });
    }
    const last = fresh.length ? fresh[fresh.length - 1] : null;
    candidate = last ? last.text : "";
    candEl = last ? last.el : null;
    const thEl = lastThinkingEl();
    if (thEl && thEl !== baselineThinkingEl) {
      if (thEl !== thinkingEl) {
        thinkingEl = thEl;
        thinkingText = "";
      }
      const t = (thEl.textContent || "").trim();
      if (t.length > thinkingText.length) thinkingText = t;
    }
    if (active || candidate !== lastSeenText) {
      lastSeenText = candidate;
      lastActivity = Date.now();
      stableSince = null;
    } else if (candidate && stableSince === null) {
      stableSince = Date.now();
    }
    if (candEl) {
      const turnRoot = candEl.closest("[data-turn-id]") || candEl;
      const cont = [...turnRoot.querySelectorAll("button")].find(
        (b) => visible(b) && /continue/i.test((b as HTMLElement).innerText || "")
      );
      if (cont) {
        (cont as HTMLElement).click();
        await sleep(500);
        continue;
      }
    }
    if (Date.now() - lastActivity > cfg.idleMs) {
      return {
        status: "timeout",
        text: candidate || "",
        conversationId: convId(),
        error: "no activity for " + Math.round((Date.now() - lastActivity) / 1000) + "s",
        diag: { elapsedMs: Date.now() - startedAt, generatingAtEnd: active },
      };
    }
    if (
      candidate &&
      !active &&
      stableSince !== null &&
      Date.now() - stableSince >= S.stabilityMs
    ) {
      return {
        status: "done",
        text: candidate,
        conversationId: convId(),
        thinking: readThinking(),
        diag: { elapsedMs: Date.now() - startedAt },
      };
    }
    await sleep(400);
  }
  return {
    status: "timeout",
    text: candidate || "",
    conversationId: convId(),
    error: "hard deadline reached",
    diag: { elapsedMs: Date.now() - startedAt },
  };
}
