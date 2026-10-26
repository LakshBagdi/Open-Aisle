"use client";
/**
 * Voice with the browser's own speech tools (free, no keys).
 *  - listen(): one utterance of speech recognition, with live captions while
 *    the person talks (Chrome, Edge and Safari support it)
 *  - speak():  read text aloud, then call back, so the companion can start
 *    listening again for a hands-free conversation. Long text is split into
 *    sentences, because Chrome silently cuts off a single utterance after
 *    about 15 seconds, which would chop the end off a read-back.
 *  - chime():  short tones so someone who can't see the screen knows when the
 *    microphone opens and closes
 */
import { useCallback, useEffect, useRef, useState } from "react";

type RecognitionResult = { isFinal: boolean; 0: { transcript: string }; length: number };
type Recognition = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: { resultIndex: number; results: ArrayLike<RecognitionResult> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
};

export type ListenHandlers = {
  onInterim?: (text: string) => void;
  onFinal: (text: string) => void;
  /** code is the browser's error code: "no-speech", "not-allowed", ... */
  onError: (code: string, message: string) => void;
};

function getRecognition(): (new () => Recognition) | undefined {
  if (typeof window === "undefined") return undefined;
  const w = window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
}

const ERRORS: Record<string, string> = {
  "no-speech": "I didn't hear anything. Press the talk button and try again.",
  "not-allowed": "The microphone is blocked. Allow it in the browser's address bar, or type instead.",
  "service-not-allowed": "The microphone is blocked. Allow it in the browser's address bar, or type instead.",
  "audio-capture": "I can't find a microphone. Check it's plugged in, or type instead.",
  network: "Voice input needs an internet connection. Type instead, or try again.",
};

/** Split into sentence-sized pieces (max ~220 characters each). */
export function speechChunks(text: string): string[] {
  // Split only where a sentence ends (punctuation then a space), never inside "$54.99".
  const sentences = text.replace(/\s+/g, " ").trim().split(/(?<=[.!?।])\s+/);
  const out: string[] = [];
  for (const raw of sentences) {
    const s = raw.trim();
    if (!s) continue;
    const last = out.at(-1);
    if (last && last.length + s.length < 220) out[out.length - 1] = `${last} ${s}`;
    else out.push(s);
  }
  return out;
}

export function useSpeech(lang: "en" | "hi", rate = 1) {
  const [supported, setSupported] = useState(false);
  const [canSpeak, setCanSpeak] = useState(false);
  const [listening, setListening] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const rec = useRef<Recognition | null>(null);
  const audio = useRef<AudioContext | null>(null);
  const speakToken = useRef(0);
  const locale = lang === "hi" ? "hi-IN" : "en-US";

  useEffect(() => {
    setSupported(Boolean(getRecognition()));
    setCanSpeak(typeof window !== "undefined" && "speechSynthesis" in window);
    // Some browsers load voices late; asking once warms the list up.
    window.speechSynthesis?.getVoices();
  }, []);

  const chime = useCallback((kind: "open" | "close") => {
    try {
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctx) return;
      audio.current ??= new Ctx();
      const ctx = audio.current;
      const notes = kind === "open" ? [523.25, 783.99] : [783.99, 523.25];
      notes.forEach((freq, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        const t = ctx.currentTime + i * 0.09;
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, t);
        gain.gain.exponentialRampToValueAtTime(0.12, t + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
        osc.connect(gain).connect(ctx.destination);
        osc.start(t);
        osc.stop(t + 0.16);
      });
    } catch {
      /* sound is a nicety; never block voice on it */
    }
  }, []);

  const silence = useCallback(() => {
    speakToken.current++;
    window.speechSynthesis?.cancel();
    setSpeaking(false);
  }, []);

  const listen = useCallback(
    (h: ListenHandlers) => {
      const Ctor = getRecognition();
      if (!Ctor) return h.onError("unsupported", "Voice input isn't available in this browser. Try Chrome, Edge or Safari, or type instead.");
      silence();
      rec.current?.abort();
      const r = new Ctor();
      r.lang = locale;
      r.interimResults = true;
      r.continuous = false;
      r.maxAlternatives = 1;
      let finalText = "";
      let failed = false;
      r.onresult = (e) => {
        let interim = "";
        finalText = "";
        for (let i = 0; i < e.results.length; i++) {
          const res = e.results[i]!;
          if (res.isFinal) finalText += res[0].transcript;
          else interim += res[0].transcript;
        }
        h.onInterim?.((finalText + interim).trim());
      };
      r.onerror = (e) => {
        if (e.error === "aborted") return;
        failed = true;
        h.onError(e.error, ERRORS[e.error] ?? "Voice input stopped. Please try again.");
      };
      r.onend = () => {
        setListening(false);
        chime("close");
        const text = finalText.trim();
        if (text) h.onFinal(text);
        else if (!failed) h.onError("no-speech", ERRORS["no-speech"]!);
      };
      rec.current = r;
      setListening(true);
      chime("open");
      try {
        r.start();
      } catch {
        setListening(false);
        h.onError("busy", "The microphone is busy. Please try again.");
      }
    },
    [locale, chime, silence],
  );

  const stop = useCallback(() => {
    rec.current?.stop();
  }, []);

  const speak = useCallback(
    (text: string, onDone?: () => void) => {
      if (typeof window === "undefined" || !window.speechSynthesis || !text.trim()) return onDone?.();
      const token = ++speakToken.current;
      window.speechSynthesis.cancel();
      const voices = window.speechSynthesis.getVoices();
      const voice = voices.find((v) => v.lang === locale && /natural|neural|google/i.test(v.name)) ?? voices.find((v) => v.lang === locale) ?? voices.find((v) => v.lang.startsWith(lang));
      const chunks = speechChunks(text);
      setSpeaking(true);
      chunks.forEach((chunk, i) => {
        const u = new SpeechSynthesisUtterance(chunk);
        u.lang = locale;
        u.rate = Math.min(2, Math.max(0.6, rate));
        if (voice) u.voice = voice;
        if (i === chunks.length - 1) {
          u.onend = () => {
            if (token !== speakToken.current) return; // interrupted by newer speech
            setSpeaking(false);
            onDone?.();
          };
          u.onerror = (e) => {
            if (token !== speakToken.current) return;
            setSpeaking(false);
            if (e.error !== "interrupted" && e.error !== "canceled") onDone?.();
          };
        }
        window.speechSynthesis.speak(u);
      });
    },
    [locale, lang, rate],
  );

  return { supported, canSpeak, listening, speaking, listen, stop, speak, silence, chime };
}
