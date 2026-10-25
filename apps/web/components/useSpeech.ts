"use client";
/**
 * Voice, with the browser's own speech tools (free, no keys, nothing leaves
 * the browser except the words recognised).
 *
 *  - listen(): hear one request. A short rising tone means "I'm listening",
 *    a falling tone means "got it", so someone who can't see the screen
 *    always knows the microphone's state.
 *  - speak():  read text aloud. Long text is split into sentences, because
 *    Chrome silently cuts off a single utterance after about 15 seconds,
 *    which would chop the end off a read-back.
 *  - silence(): stop talking now (Escape does this too).
 *
 * Speech recognition works in Chrome, Edge and Safari; Firefox can still use
 * spoken replies and the keyboard.
 */
import { useCallback, useEffect, useRef, useState } from "react";

type Recognition = {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  continuous: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
};

function getRecognition(): (new () => Recognition) | undefined {
  if (typeof window === "undefined") return undefined;
  const w = window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
}

/** Split into sentence-sized pieces (max ~220 characters each). */
export function speechChunks(text: string): string[] {
  const sentences = text.replace(/\s+/g, " ").match(/[^.!?।]+[.!?।]*/g) ?? [text];
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

let audio: AudioContext | undefined;
/** A short tone: up = listening, down = done. Quiet, under half a second. */
function tone(direction: "up" | "down") {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    audio ??= new Ctx();
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    const t0 = audio.currentTime;
    osc.frequency.setValueAtTime(direction === "up" ? 520 : 780, t0);
    osc.frequency.linearRampToValueAtTime(direction === "up" ? 780 : 520, t0 + 0.18);
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(0.12, t0 + 0.03);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.22);
    osc.connect(gain).connect(audio.destination);
    osc.start(t0);
    osc.stop(t0 + 0.25);
  } catch {
    /* sound is a nice-to-have */
  }
}

export function useSpeech(lang: "en" | "hi", rate = 1) {
  const [supported, setSupported] = useState(false);
  const [canSpeak, setCanSpeak] = useState(false);
  const [listening, setListening] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const rec = useRef<Recognition | null>(null);
  const speakToken = useRef(0);
  const locale = lang === "hi" ? "hi-IN" : "en-US";

  useEffect(() => {
    setSupported(Boolean(getRecognition()));
    setCanSpeak(typeof window !== "undefined" && "speechSynthesis" in window);
    // Chrome loads voices lazily; asking once makes them ready for the first reply.
    window.speechSynthesis?.getVoices();
  }, []);

  const silence = useCallback(() => {
    speakToken.current++;
    window.speechSynthesis?.cancel();
    setSpeaking(false);
  }, []);

  const speak = useCallback(
    (text: string, onEnd?: () => void) => {
      if (typeof window === "undefined" || !window.speechSynthesis || !text.trim()) {
        onEnd?.();
        return;
      }
      const token = ++speakToken.current;
      window.speechSynthesis.cancel();
      const voices = window.speechSynthesis.getVoices();
      const voice = voices.find((v) => v.lang === locale && v.localService) ?? voices.find((v) => v.lang === locale) ?? voices.find((v) => v.lang.startsWith(lang));
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
            onEnd?.();
          };
          u.onerror = () => {
            if (token === speakToken.current) setSpeaking(false);
          };
        }
        window.speechSynthesis.speak(u);
      });
    },
    [locale, lang, rate],
  );

  const stop = useCallback(() => {
    rec.current?.stop();
    setListening(false);
  }, []);

  const listen = useCallback(
    (onText: (text: string) => void, onError: (message: string) => void) => {
      const Ctor = getRecognition();
      if (!Ctor) return onError("Voice input isn't available in this browser. Try Chrome, Edge or Safari, or type instead.");
      silence();
      rec.current?.abort();
      const r = new Ctor();
      r.lang = locale;
      r.interimResults = false;
      r.maxAlternatives = 1;
      r.continuous = false;
      let heard = false;
      r.onresult = (e) => {
        const text = e.results[0]?.[0]?.transcript?.trim();
        if (text) {
          heard = true;
          tone("down");
          onText(text);
        }
      };
      r.onerror = (e) => {
        if (e.error === "aborted") return;
        if (e.error === "no-speech") onError("I didn't hear anything. Press Talk and try again.");
        else if (e.error === "not-allowed" || e.error === "service-not-allowed") onError("The microphone is blocked. Allow it for this site in the browser, or type instead.");
        else if (e.error === "network") onError("Voice needs an internet connection in this browser. You can type instead.");
        else onError("Voice input stopped. Please try again.");
      };
      r.onend = () => {
        setListening(false);
        if (!heard) tone("down");
      };
      rec.current = r;
      setListening(true);
      tone("up");
      try {
        r.start();
      } catch {
        setListening(false);
        onError("The microphone is busy. Try again in a moment.");
      }
    },
    [locale, silence],
  );

  return { supported, canSpeak, listening, speaking, listen, stop, speak, silence };
}
