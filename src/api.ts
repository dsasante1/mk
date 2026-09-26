// The Rust side, typed. Every `invoke` in the app goes through here, so a
// renamed command is one compile error rather than a silent runtime failure.

import { invoke } from "@tauri-apps/api/core";

export interface Fix {
  label: string;
  from: number;
  to: number;
  insert: string;
}

/** One Harper finding. Offsets are UTF-16 code units, as CodeMirror counts. */
export interface Issue {
  from: number;
  to: number;
  rule: string;
  kind: string;
  message: string;
  text: string;
  fixes: Fix[];
  hash: string;
}

export interface Rule {
  name: string;
  description: string;
  enabled: boolean;
}

export type Theme = "system" | "dark" | "light";
export type View = "edit" | "split" | "preview";

export interface Settings {
  theme: Theme;
  view: View;
  fontSize: number;
  editorFont: string;
  lineNumbers: boolean;
  wrap: boolean;
  syncScroll: boolean;
  split: number;
  problemsOpen: boolean;
  grammar: boolean;
  dialect: string;
  rules: Record<string, boolean>;
  // Keys a newer build wrote ride along untouched.
  [extra: string]: unknown;
}

export interface Doc {
  path: string;
  content: string;
  mtime: number | null;
}

export interface Launch {
  path: string | null;
  view: View | null;
}

export interface About {
  version: string;
  harper: string;
  config_dir: string;
}

export const api = {
  launch: () => invoke<Launch>("launch"),
  readFile: (path: string) => invoke<Doc>("read_file", { path }),
  writeFile: (path: string, content: string) => invoke<number | null>("write_file", { path, content }),
  fileMtime: (path: string) => invoke<number | null>("file_mtime", { path }),
  lint: (text: string) => invoke<Issue[]>("lint", { text }),
  rules: () => invoke<Rule[]>("grammar_rules"),
  settingsGet: () => invoke<Settings>("settings_get"),
  settingsSet: (value: Settings) => invoke<void>("settings_set", { value }),
  words: () => invoke<string[]>("words_get"),
  wordAdd: (word: string) => invoke<string[]>("word_add", { word }),
  wordRemove: (word: string) => invoke<string[]>("word_remove", { word }),
  ignoredGet: (path: string) => invoke<string[]>("ignored_get", { path }),
  ignoreAdd: (path: string, hash: string) => invoke<void>("ignore_add", { path, hash }),
  ignoreClear: (path: string) => invoke<void>("ignore_clear", { path }),
  about: () => invoke<About>("about"),
};

export const DIALECTS = ["American", "British", "Canadian", "Australian", "Indian"];
