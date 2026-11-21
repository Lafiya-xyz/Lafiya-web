/**
 * Issue #928: optional voice dictation for profile fields.
 *
 * Privacy posture (see docs/voice-dictation-privacy.md):
 * - Recognition is on-device only. We never request microphone access when the
 *   browser cannot guarantee local recognition, and we never upload audio.
 * - No audio is recorded, buffered, or persisted by this module; only the
 *   transcript string is handed back to the caller for explicit confirmation.
 * - Nothing here runs unless the user presses a dictation button.
 */

export const DICTATION_LANGUAGES = [
  { code: "en-NG", label: "English" },
  { code: "ha-NG", label: "Hausa" },
  { code: "yo-NG", label: "Yoruba" },
  { code: "ig-NG", label: "Igbo" },
] as const;

export type DictationLanguage = (typeof DICTATION_LANGUAGES)[number]["code"];

export type DictationFieldKind = "name" | "language" | "tag";

/** Minimal shape of the Web Speech API we rely on (not in lib.dom). */
type SpeechRecognitionAlternative = { transcript: string };
type SpeechRecognitionResult = {
  isFinal: boolean;
  length: number;
  [index: number]: SpeechRecognitionAlternative;
};
type SpeechRecognitionEventLike = {
  resultIndex: number;
  results: { length: number; [index: number]: SpeechRecognitionResult };
};
type SpeechRecognitionErrorEventLike = { error: string };
type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  processLocally?: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
};
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  }
}

/**
 * Returns the recognition constructor only when the browser exposes the
 * on-device `processLocally` capability. Browsers that would stream audio to a
 * remote service are treated as unsupported so no audio ever leaves the device.
 */
export function getOnDeviceRecognition(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const ctor = window.SpeechRecognition ?? window.webkitSpeechRecognition;
  if (!ctor) return null;
  try {
    const probe = new ctor();
    return "processLocally" in probe ? ctor : null;
  } catch {
    return null;
  }
}

export function isDictationSupported(): boolean {
  return getOnDeviceRecognition() !== null;
}

/**
 * Clinical vocabulary post-processing. Speech engines trained on general
 * English mis-hear drug and condition names; these mappings are applied to the
 * transcript before it is shown for confirmation. Keys are lower-cased and
 * matched on word boundaries.
 */
const CLINICAL_CORRECTIONS: Record<string, string> = {
  "high blood pressure": "hypertension",
  "sickle cell": "sickle cell disease",
  "sickle cell anaemia": "sickle cell disease",
  "sickle cell anemia": "sickle cell disease",
  "sugar disease": "diabetes",
  "diabetic": "diabetes",
  "asthma attack": "asthma",
  "peanut": "peanut allergy",
  "penicillin": "penicillin allergy",
  "sulfa": "sulfa allergy",
  "ulcer": "peptic ulcer disease",
  "kidney problem": "chronic kidney disease",
  "heart problem": "heart disease",
  "fits": "seizures",
  "convulsion": "seizures",
  "tb": "tuberculosis",
  "hiv": "HIV",
  "hepatitis b": "hepatitis B",
  "panadol": "paracetamol",
  "typhoid": "typhoid fever",
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function postProcessTranscript(
  transcript: string,
  kind: DictationFieldKind = "tag",
): string {
  let text = transcript.replace(/\s+/g, " ").trim();
  if (text === "") return "";

  for (const [spoken, clinical] of Object.entries(CLINICAL_CORRECTIONS)) {
    const pattern = new RegExp(`\\b${escapeRegExp(spoken)}\\b`, "gi");
    text = text.replace(pattern, clinical);
  }

  if (kind === "name") {
    // Names are dictated letter-by-letter by some engines; keep casing natural.
    text = text
      .split(" ")
      .map((word) =>
        word.length > 0 ? word[0].toUpperCase() + word.slice(1) : word,
      )
      .join(" ");
  }

  return text;
}

export type DictationSession = {
  stop(): void;
  abort(): void;
};

/**
 * Starts a single dictation session. `onTranscript` receives the post-processed
 * transcript; the caller must show it for explicit confirmation before writing
 * it into the form. Audio is never retained.
 */
export function startDictation(options: {
  language: DictationLanguage;
  kind?: DictationFieldKind;
  onTranscript: (text: string) => void;
  onError: (message: string) => void;
  onEnd: () => void;
}): DictationSession | null {
  const Ctor = getOnDeviceRecognition();
  if (!Ctor) return null;

  const recognition = new Ctor();
  recognition.lang = options.language;
  recognition.continuous = false;
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;
  if ("processLocally" in recognition) recognition.processLocally = true;

  let finalText = "";

  recognition.onresult = (event) => {
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const result = event.results[i];
      if (result.isFinal) finalText += result[0]?.transcript ?? "";
    }
  };
  recognition.onerror = (event) => {
    options.onError(
      event.error === "not-allowed" || event.error === "service-not-allowed"
        ? "Microphone access was blocked. Dictation is optional; you can type instead."
        : "Dictation stopped unexpectedly. You can try again or type instead.",
    );
  };
  recognition.onend = () => {
    const text = postProcessTranscript(finalText, options.kind ?? "tag");
    if (text !== "") options.onTranscript(text);
    options.onEnd();
  };

  try {
    recognition.start();
  } catch {
    options.onError("Dictation could not start. You can type instead.");
    options.onEnd();
    return null;
  }

  return {
    stop: () => recognition.stop(),
    abort: () => recognition.abort(),
  };
}
