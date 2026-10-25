/**
 * Every fixed sentence Open Aisle says, in English and Hindi.
 * The AI writes its own conversational replies in the person's language;
 * these are the sentences code says (read-back, payment results, errors),
 * which must be exact.
 */
export type Lang = "en" | "hi";

const strings = {
  en: {
    "readback.intro": "Here is your order from {store}.",
    "readback.option": "{name}",
    "readback.subtotal": "items",
    "readback.tax": "tax",
    "readback.delivery": "delivery",
    "readback.freeDelivery": "free delivery",
    "readback.total": "Total",
    "readback.arrives": "It should arrive {date}, from {store}.",
    "readback.undo": "After you confirm, you have {minutes} minutes to cancel. Nothing is charged until then.",
    "readback.ask": "Say confirm to place the order, or tell me what to change.",
    "order.held": "Order placed. The money is held, not taken. You have {minutes} minutes to cancel.",
    "order.voided": "Cancelled. Nothing was charged.",
    "order.captured": "Done. You paid {amount} to {store}.",
    "order.tooLate": "It's too late to cancel. You were already charged, but I can start a return for you.",
    "order.refundStarted": "Return started. {store} will refund {amount} to your PayPal.",
    "confirm.phrase": "confirm",
    "ui.title": "Open Aisle",
  },
  hi: {
    "readback.intro": "{store} से आपका ऑर्डर यह है।",
    "readback.option": "{name}",
    "readback.subtotal": "सामान",
    "readback.tax": "टैक्स",
    "readback.delivery": "डिलीवरी",
    "readback.freeDelivery": "मुफ़्त डिलीवरी",
    "readback.total": "कुल",
    "readback.arrives": "यह {date} तक {store} से पहुँच जाना चाहिए।",
    "readback.undo": "पुष्टि करने के बाद आपके पास रद्द करने के लिए {minutes} मिनट हैं। तब तक कोई पैसा नहीं कटेगा।",
    "readback.ask": "ऑर्डर देने के लिए 'पुष्टि' कहें, या बताइए क्या बदलना है।",
    "order.held": "ऑर्डर हो गया। पैसा रोका गया है, लिया नहीं गया। आपके पास रद्द करने के लिए {minutes} मिनट हैं।",
    "order.voided": "रद्द हो गया। कोई पैसा नहीं कटा।",
    "order.captured": "हो गया। आपने {store} को {amount} दिए।",
    "order.tooLate": "अब रद्द करने में देर हो गई है। पैसा कट चुका है, लेकिन मैं वापसी शुरू कर सकता हूँ।",
    "order.refundStarted": "वापसी शुरू हो गई। {store} आपके PayPal में {amount} लौटाएगा।",
    "confirm.phrase": "पुष्टि",
    "ui.title": "ओपन आइल",
  },
} as const;

export type StringKey = keyof (typeof strings)["en"];

export function t(lang: Lang, key: StringKey, vars: Record<string, string> = {}): string {
  const template: string = strings[lang]?.[key] ?? strings.en[key];
  return template.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? `{${k}}`);
}

/** Words that count as "yes, place the order" when spoken right after a read-back. */
export const CONFIRM_WORDS: Record<Lang, string[]> = {
  en: ["confirm", "yes confirm", "confirm order", "place the order", "place order"],
  hi: ["पुष्टि", "पुष्टि करें", "हाँ पुष्टि", "ऑर्डर करो", "ऑर्डर कर दो"],
};

function normalise(text: string) {
  return text
    .trim()
    .toLowerCase()
    .replace(/[.!?,।]+/g, "")
    .replace(/\s+/g, " ");
}

export function isConfirmPhrase(text: string, lang: Lang): boolean {
  const said = normalise(text);
  return [...CONFIRM_WORDS[lang], ...CONFIRM_WORDS.en].some((w) => said === w);
}

/**
 * Short spoken commands the app handles itself, without the AI, so they are
 * instant and can't be misunderstood. Each must match the WHOLE phrase:
 * "cancel that" cancels; "don't cancel that" does not match anything.
 */
const COMMANDS: Record<"cancel" | "change" | "dont_order" | "repeat" | "stop" | "help", Record<Lang, string[]>> = {
  cancel: {
    en: ["cancel", "cancel that", "cancel it", "cancel my order", "cancel the order", "undo", "undo that"],
    hi: ["रद्द", "रद्द करो", "रद्द कर दो", "ऑर्डर रद्द करो", "कैंसल", "कैंसल करो"],
  },
  change: { en: ["change", "change something", "change it", "go back"], hi: ["बदलो", "बदलना है", "वापस"] },
  dont_order: { en: ["don't order", "do not order", "no", "no thanks", "not now"], hi: ["नहीं", "ऑर्डर मत करो", "अभी नहीं"] },
  repeat: { en: ["repeat", "say that again", "repeat that", "what did you say", "again"], hi: ["फिर से बोलो", "दोबारा", "दोबारा बोलो"] },
  stop: { en: ["stop", "stop talking", "be quiet", "quiet"], hi: ["रुको", "चुप", "बस"] },
  help: { en: ["help", "what can i say", "what can you do"], hi: ["मदद", "क्या बोल सकते हैं"] },
};

export type VoiceCommand = keyof typeof COMMANDS;

/** Which app command (if any) the person said. */
export function voiceCommand(text: string, lang: Lang): VoiceCommand | null {
  const said = normalise(text).replace(/’/g, "'");
  for (const [cmd, words] of Object.entries(COMMANDS) as [VoiceCommand, Record<Lang, string[]>][]) {
    if ([...words[lang], ...words.en].some((w) => said === w)) return cmd;
  }
  return null;
}
