// The voices: piper through the Rust side, or the webview's own.
//
// Both take a list of sentences and a place to start, say when each sentence
// begins, and pause, resume and stop. The reader does not care which it has.
//
// piper is the good one. Each sentence is synthesised on the Rust side and
// comes back as a WAV that an <audio> element plays, so a pause lands
// mid-word and resume carries on from there. Speed is the element's playback
// rate, with pitch kept: a speed change is heard at once and needs no new
// audio. The next two sentences are made while the current one plays, which
// is what keeps the reading gapless; recent ones are kept, so stepping back a
// sentence replays instantly.
//
// The webview's speech is the fallback when piper is not installed. On macOS
// and Windows its voices are the system's and good; on Linux WebKitGTK uses
// Flite, which is clear but robotic.

import { api } from "./api";

export interface EngineEvents {
  /** Sentence `index` has begun. */
  start(index: number): void;
  /** The last sentence has ended. */
  done(): void;
  error(message: string): void;
}

export interface Engine {
  readonly label: string;
  /** Read `texts` from `from` on, replacing anything already playing. */
  speak(texts: string[], from: number): void;
  pause(): void;
  resume(): void;
  stop(): void;
  setRate(rate: number): void;
  dispose(): void;
}

/** How many sentences to synthesise ahead of the one playing. */
const AHEAD = 2;
/** How many finished clips to keep, for stepping back. */
const KEEP = 24;

export class PiperEngine implements Engine {
  readonly label: string;
  private audio = new Audio();
  private texts: string[] = [];
  /** Bumped by every speak and stop; a run that finds it changed gives up. */
  private gen = 0;
  private paused = false;
  private rate = 1;
  private clips = new Map<string, Promise<string>>();
  /** Resolves the wait on the clip now playing, so stop() can end it at once. */
  private finish: (() => void) | null = null;

  constructor(private voice: { name: string; path: string }, private ev: EngineEvents) {
    this.label = voice.name;
  }

  speak(texts: string[], from: number) {
    this.stop();
    this.texts = texts;
    this.paused = false;
    void this.run(++this.gen, from);
  }

  private async run(gen: number, from: number) {
    for (let i = from; i < this.texts.length; i++) {
      // The sentence needed now is asked for first, then the ones after it.
      const now = this.clip(this.texts[i]);
      for (let k = 1; k <= AHEAD; k++) if (i + k < this.texts.length) void this.clip(this.texts[i + k]).catch(() => {});
      let url: string;
      try {
        url = await now;
      } catch (e) {
        if (gen === this.gen) { this.ev.error(String(e)); this.stop(); }
        return;
      }
      if (gen !== this.gen) return;
      this.ev.start(i);
      await this.play(url);
      if (gen !== this.gen) return;
    }
    if (gen === this.gen) this.ev.done();
  }

  /** The clip for `text`, made once and kept for a while. */
  private clip(text: string): Promise<string> {
    let p = this.clips.get(text);
    if (p) {
      // Most recently used goes to the back, so the oldest is dropped first.
      this.clips.delete(text);
      this.clips.set(text, p);
      return p;
    }
    p = api.speechSay(text, this.voice.path).then((buf) => URL.createObjectURL(new Blob([buf], { type: "audio/wav" })));
    p.catch(() => this.clips.delete(text));
    this.clips.set(text, p);
    while (this.clips.size > KEEP) {
      const [oldest, old] = this.clips.entries().next().value as [string, Promise<string>];
      this.clips.delete(oldest);
      void old.then((u) => { if (this.audio.src !== u) URL.revokeObjectURL(u); }).catch(() => {});
    }
    return p;
  }

  /**
   * A new element per sentence. Reusing one lets an `ended` already queued
   * for the last clip arrive after the next has started, and end it at once.
   */
  private play(url: string): Promise<void> {
    return new Promise((resolve) => {
      this.audio.pause();
      const a = new Audio();
      // Pitch stays put when the speed changes.
      (a as HTMLAudioElement & { preservesPitch?: boolean }).preservesPitch = true;
      this.audio = a;
      const end = () => { a.onended = a.onerror = null; if (this.finish === end) this.finish = null; resolve(); };
      this.finish = end;
      a.onended = end;
      a.onerror = () => { this.ev.error("could not play the audio"); end(); };
      a.src = url;
      // A new source resets the rate to the default, so set both.
      a.defaultPlaybackRate = this.rate;
      a.playbackRate = this.rate;
      if (!this.paused) void a.play().catch(() => {});
    });
  }

  pause() {
    this.paused = true;
    this.audio.pause();
  }

  resume() {
    this.paused = false;
    if (this.finish) void this.audio.play().catch(() => {});
  }

  stop() {
    this.gen++;
    this.paused = false;
    this.audio.pause();
    this.finish?.();
  }

  setRate(rate: number) {
    this.rate = rate;
    this.audio.defaultPlaybackRate = rate;
    this.audio.playbackRate = rate;
  }

  dispose() {
    this.stop();
    for (const p of this.clips.values()) void p.then((u) => URL.revokeObjectURL(u)).catch(() => {});
    this.clips.clear();
    this.audio.removeAttribute("src");
  }
}

/** The webview's own voices. */
export function systemVoices(): SpeechSynthesisVoice[] {
  return typeof speechSynthesis === "undefined" ? [] : speechSynthesis.getVoices();
}

export class SystemEngine implements Engine {
  readonly label: string;
  private texts: string[] = [];
  private gen = 0;
  private rate = 1;
  private index = 0;
  private voice: SpeechSynthesisVoice | null;

  constructor(voiceName: string | null, private ev: EngineEvents) {
    const all = systemVoices();
    this.voice = (voiceName && all.find((v) => v.name === voiceName)) || all.find((v) => v.default) || all[0] || null;
    this.label = this.voice ? this.voice.name : "system voice";
  }

  speak(texts: string[], from: number) {
    this.stop();
    this.texts = texts;
    this.say(++this.gen, from);
  }

  /** One utterance at a time, so each sentence's start is known. */
  private say(gen: number, i: number) {
    if (gen !== this.gen) return;
    if (i >= this.texts.length) { this.ev.done(); return; }
    this.index = i;
    const u = new SpeechSynthesisUtterance(this.texts[i]);
    if (this.voice) u.voice = this.voice;
    u.rate = this.rate;
    u.onstart = () => { if (gen === this.gen) this.ev.start(i); };
    u.onend = () => this.say(gen, i + 1);
    u.onerror = (e) => {
      if (gen !== this.gen || e.error === "interrupted" || e.error === "canceled") return;
      this.ev.error(`speech failed: ${e.error}`);
    };
    speechSynthesis.speak(u);
  }

  pause() { speechSynthesis.pause(); }
  resume() { speechSynthesis.resume(); }

  stop() {
    this.gen++;
    speechSynthesis.cancel();
  }

  /** An utterance keeps the rate it started with, so the current one is restarted. */
  setRate(rate: number) {
    if (rate === this.rate) return;
    this.rate = rate;
    if (speechSynthesis.speaking && !speechSynthesis.paused) this.speak(this.texts, this.index);
  }

  dispose() { this.stop(); }
}

/** A readable name for a piper model: "en_US-ryan-high" → "Ryan (US English, high)". */
export function voiceLabel(name: string): string {
  const m = /^([a-z]{2,3})_([A-Z]{2})-(.+?)-(x_low|low|medium|high)$/.exec(name);
  if (!m) return name;
  const lang = ({ en: "English", fr: "French", de: "German", es: "Spanish", pt: "Portuguese", it: "Italian", nl: "Dutch" } as Record<string, string>)[m[1]] ?? m[1];
  const who = m[3].replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  return `${who} (${m[2]} ${lang}, ${m[4].replace("_", "-")})`;
}

/**
 * The voice to use when Settings say "automatic": a British piper voice if
 * there is one, then a medium-quality one (several times faster to make than
 * a high one, which matters when each sentence is made as it is read), then
 * whatever there is.
 */
export function autoVoice<T extends { name: string }>(voices: T[]): T | null {
  return voices.find((v) => v.name.startsWith("en_GB")) ?? voices.find((v) => v.name.endsWith("-medium")) ?? voices[0] ?? null;
}
