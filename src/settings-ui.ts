// The settings dialog. It edits a copy and hands every change straight back
// through `onChange`, so there is no Apply button and nothing to lose by
// closing it.

import DOMPurify from "dompurify";
import markdownit from "markdown-it";
import { api, DIALECTS, type Rule, type Settings } from "./api";
import { ruleLabel } from "./grammar";

const inline = markdownit({ html: false, linkify: false });

function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...kids: (Node | string)[]) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  el.append(...kids);
  return el;
}

export interface SettingsHooks {
  current(): Settings;
  onChange(s: Settings): void;
  /** After the dictionary or rules change, so the document is re-checked. */
  relint(): void;
  ignoredCount(): number;
  clearIgnored(): void;
}

export class SettingsDialog {
  private rules: Rule[] = [];
  private words: string[] = [];
  private filter = "";

  constructor(private dlg: HTMLDialogElement, private hooks: SettingsHooks) {
    dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });
  }

  get open() { return this.dlg.open; }

  async show() {
    [this.rules, this.words] = await Promise.all([api.rules(), api.words()]);
    this.build();
    if (!this.dlg.open) this.dlg.showModal();
  }

  close() { this.dlg.close(); }

  private set(patch: Partial<Settings>) {
    this.hooks.onChange({ ...this.hooks.current(), ...patch });
  }

  private build() {
    const s = this.hooks.current();
    const d = this.dlg;
    const scroll = d.querySelector(".settings-body")?.scrollTop ?? 0;
    d.replaceChildren();

    const close = h("button", { class: "icon", "data-tip": "Close (Esc)" }, "✕");
    close.onclick = () => d.close();
    d.append(h("header", {}, h("h2", {}, "Settings"), close));

    const body = h("div", { class: "settings-body" });
    d.append(body);

    // ---- appearance ----
    body.append(h("h3", {}, "Appearance"));
    body.append(this.select("Theme", s.theme, [["system", "Follow system"], ["dark", "Dark"], ["light", "Light"]], (v) => this.set({ theme: v as Settings["theme"] })));
    body.append(this.number("Editor font size", s.fontSize, 10, 28, (v) => this.set({ fontSize: v })));
    body.append(this.text("Editor font", s.editorFont, "Default (monospace)", (v) => this.set({ editorFont: v })));
    body.append(this.toggle("Wrap long lines", s.wrap, (v) => this.set({ wrap: v })));
    body.append(this.toggle("Line numbers", s.lineNumbers, (v) => this.set({ lineNumbers: v })));
    body.append(this.toggle("Sync preview scrolling with the editor", s.syncScroll, (v) => this.set({ syncScroll: v })));
    body.append(this.toggle("Section markers at the edge of the page", s.sectionNav, (v) => this.set({ sectionNav: v })));

    // ---- grammar ----
    body.append(h("h3", {}, "Harper"));
    body.append(this.toggle("Check spelling and grammar", s.grammar, (v) => this.set({ grammar: v })));
    body.append(this.select("Dialect", s.dialect, DIALECTS.map((x) => [x, x]), (v) => { this.set({ dialect: v }); this.hooks.relint(); }));
    const ignored = this.hooks.ignoredCount();
    if (ignored > 0) {
      const b = h("button", {}, `Restore ${ignored} ignored issue${ignored === 1 ? "" : "s"} in this file`);
      b.onclick = () => { this.hooks.clearIgnored(); this.build(); };
      body.append(h("div", { class: "row" }, b));
    }

    // ---- dictionary ----
    body.append(h("h3", {}, "Personal dictionary"));
    const input = h("input", { type: "text", placeholder: "Add a word…", spellcheck: "false" }) as HTMLInputElement;
    const add = h("button", {}, "Add");
    const addWord = async () => {
      const w = input.value.trim();
      if (!w) return;
      try {
        this.words = await api.wordAdd(w);
        this.hooks.relint();
        this.build();
        (this.dlg.querySelector(".dict-add input") as HTMLInputElement | null)?.focus();
      } catch (e) {
        input.setCustomValidity(String(e));
        input.reportValidity();
      }
    };
    add.onclick = addWord;
    input.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); void addWord(); } };
    input.oninput = () => input.setCustomValidity("");
    body.append(h("div", { class: "row dict-add" }, input, add));
    const list = h("div", { class: "chips" });
    if (this.words.length === 0) list.append(h("span", { class: "hint" }, "Words you add from a spelling issue land here."));
    for (const w of this.words) {
      const x = h("button", { class: "chip-x", "aria-label": `Remove ${w}` }, "✕");
      x.onclick = async () => { this.words = await api.wordRemove(w); this.hooks.relint(); this.build(); };
      list.append(h("span", { class: "chip" }, w, x));
    }
    body.append(list);

    // ---- rules ----
    const overrides = Object.keys(s.rules).length;
    body.append(h("h3", {}, `Rules `, h("span", { class: "hint" }, `${this.rules.filter((r) => r.enabled).length} of ${this.rules.length} on`)));
    const search = h("input", { type: "search", placeholder: "Filter rules…", value: this.filter }) as HTMLInputElement;
    const reset = h("button", {}, "Reset to Harper defaults");
    reset.disabled = overrides === 0;
    reset.onclick = async () => {
      this.set({ rules: {} });
      this.rules = await api.rules();
      this.hooks.relint();
      this.build();
    };
    body.append(h("div", { class: "row" }, search, reset));
    const ruleList = h("div", { class: "rules" });
    const fill = () => {
      ruleList.replaceChildren();
      const q = this.filter.toLowerCase();
      for (const r of this.rules) {
        const label = ruleLabel(r.name);
        if (q && !label.toLowerCase().includes(q) && !r.name.toLowerCase().includes(q) && !r.description.toLowerCase().includes(q)) continue;
        const cb = h("input", { type: "checkbox" }) as HTMLInputElement;
        cb.checked = r.enabled;
        cb.onchange = async () => {
          r.enabled = cb.checked;
          const rules = { ...this.hooks.current().rules, [r.name]: cb.checked };
          this.set({ rules });
          this.hooks.relint();
        };
        const desc = h("div", { class: "rule-desc" });
        desc.innerHTML = DOMPurify.sanitize(inline.renderInline(r.description));
        ruleList.append(h("label", { class: "rule" }, cb, h("div", {}, h("div", { class: "rule-name" }, label), desc)));
      }
      if (!ruleList.childElementCount) ruleList.append(h("div", { class: "hint" }, "No rule matches."));
    };
    search.oninput = () => { this.filter = search.value; fill(); };
    fill();
    body.append(ruleList);

    // ---- about ----
    const about = h("p", { class: "hint about" });
    void api.about().then((a) => {
      about.textContent = `mk ${a.version} · Harper ${a.harper} · settings in ${a.config_dir}`;
    });
    body.append(about);

    body.scrollTop = scroll;
  }

  private field(label: string, control: HTMLElement) {
    return h("label", { class: "field" }, h("span", {}, label), control);
  }

  private toggle(label: string, value: boolean, set: (v: boolean) => void) {
    const cb = h("input", { type: "checkbox" }) as HTMLInputElement;
    cb.checked = value;
    cb.onchange = () => set(cb.checked);
    return h("label", { class: "field check" }, cb, h("span", {}, label));
  }

  private select(label: string, value: string, options: string[][], set: (v: string) => void) {
    const sel = h("select");
    for (const [v, text] of options) {
      const o = h("option", { value: v }, text);
      if (v === value) o.selected = true;
      sel.append(o);
    }
    sel.onchange = () => set(sel.value);
    return this.field(label, sel);
  }

  private number(label: string, value: number, min: number, max: number, set: (v: number) => void) {
    const inp = h("input", { type: "number", min: String(min), max: String(max), value: String(value) }) as HTMLInputElement;
    inp.onchange = () => {
      const v = Math.round(Number(inp.value));
      if (Number.isFinite(v)) set(Math.min(max, Math.max(min, v)));
    };
    return this.field(label, inp);
  }

  private text(label: string, value: string, placeholder: string, set: (v: string) => void) {
    const inp = h("input", { type: "text", value, placeholder }) as HTMLInputElement;
    inp.onchange = () => set(inp.value);
    return this.field(label, inp);
  }
}
