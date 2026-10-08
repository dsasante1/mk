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
  sectionNav: boolean;
  split: number;
  problemsOpen: boolean;
  grammar: boolean;
  dialect: string;
  autoSave: boolean;
  rules: Record<string, boolean>;
  /** A piper voice's path, `system:<name>` for a webview voice, or "" for automatic. */
  speechVoice: string;
  /** Read-aloud speed as a playback rate; 1 is the voice's own pace. */
  speechRate: number;
  speechSkipCode: boolean;
  /** The piper program; "" means look in the usual places. */
  speechPiper: string;
  // Keys a newer build wrote ride along untouched.
  [extra: string]: unknown;
}

export interface Doc {
  path: string;
  content: string;
  mtime: number | null;
}

export interface Launch {
  paths: string[];
  view: View | null;
}

export interface Voice {
  /** The model's file name without `.onnx`, e.g. `en_US-ryan-high`. */
  name: string;
  path: string;
}

export interface SpeechInfo {
  piper: string | null;
  voices: Voice[];
}

export interface RulesFile {
  path: string;
  text: string;
}

/** Where a document was left, by sentence index and that sentence's text. */
export interface Place {
  path: string;
  sentence: number;
  text: string;
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
  recentGet: () => invoke<string[]>("recent_get"),
  recentAdd: (path: string) => invoke<string[]>("recent_add", { path }),
  recentClear: () => invoke<void>("recent_clear"),
  about: () => invoke<About>("about"),
  speechInfo: () => invoke<SpeechInfo>("speech_info"),
  /** One sentence as WAV bytes. */
  speechSay: (text: string, voice: string) => invoke<ArrayBuffer>("speech_say", { text, voice }),
  speechRules: (path: string) => invoke<RulesFile | null>("speech_rules", { path }),
  placeGet: (path: string) => invoke<Place | null>("speech_place_get", { path }),
  placeSet: (place: Place) => invoke<void>("speech_place_set", { place }),
};

export const DIALECTS = ["American", "British", "Canadian", "Australian", "Indian"];
