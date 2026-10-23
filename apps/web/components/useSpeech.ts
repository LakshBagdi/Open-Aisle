"use client";
/**
 * Voice mode with the browser's own speech tools (free, no keys).
 *  - listen(): one utterance of speech recognition (Chrome and Edge support it)
 *  - speak():  read text aloud with the browser's voice
 *
 * Screen-reader users usually keep voice mode off: their screen reader
 * already speaks, and two voices at once is confusing.
 */
import { useCallback, useEffect, useRef, useState } from "react";

type Recognition = {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
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

export function useSpeech(lang: "en" | "hi") {
  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const rec = useRef<Recognition | null>(null);
  const locale = lang === "hi" ? "hi-IN" : "en-US";

  useEffect(() => setSupported(Boolean(getRecognition())), []);

  const listen = useCallback(
    (onText: (text: string) => void, onError: (message: string) => void) => {
      const Ctor = getRecognition();
      if (!Ctor) return onError("Voice input isn't available in this browser. Try Chrome or Edge, or type instead.");
      window.speechSynthesis?.cancel();
      const r = new Ctor();
      r.lang = locale;
      r.interimResults = false;
      r.maxAlternatives = 1;
      r.onresult = (e) => {
        const text = e.results[0]?.[0]?.transcript?.trim();
        if (text) onText(text);
      };
      r.onerror = (e) => {
        if (e.error === "no-speech") onError("I didn't hear anything. Press Talk and try again.");
        else if (e.error === "not-allowed") onError("Microphone access is blocked. Allow it in the browser, or type instead.");
        else onError("Voice input stopped. Please try again.");
      };
      r.onend = () => setListening(false);
      rec.current = r;
      setListening(true);
      r.start();
    },
    [locale],
  );

  const stop = useCallback(() => {
    rec.current?.stop();
    setListening(false);
  }, []);

  const speak = useCallback(
    (text: string) => {
      if (typeof window === "undefined" || !window.speechSynthesis) return;
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = locale;
      u.rate = 1;
      const voice = window.speechSynthesis.getVoices().find((v) => v.lang === locale);
      if (voice) u.voice = voice;
      window.speechSynthesis.speak(u);
    },
    [locale],
  );

  const silence = useCallback(() => window.speechSynthesis?.cancel(), []);

  return { supported, listening, listen, stop, speak, silence };
}
