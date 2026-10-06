export interface Speech {
  /** WAV audio (PCM). */
  wav: Buffer;
  seconds: number;
}

export interface Tts {
  readonly voiced: boolean;
  synthesize(text: string, voice: string): Promise<Speech>;
}

const SAMPLE_RATE = 24000;

/** Azure AI Speech neural voices through the REST API. */
export class AzureTts implements Tts {
  readonly voiced = true;

  constructor(private key: string, private region: string, private fetchImpl: typeof fetch = fetch) {}

  async synthesize(text: string, voice: string): Promise<Speech> {
    const lang = voice.split("-").slice(0, 2).join("-");
    const ssml = `<speak version="1.0" xml:lang="${lang}"><voice name="${escapeXml(voice)}">${escapeXml(text)}</voice></speak>`;
    const res = await this.fetchImpl(`https://${this.region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
      method: "POST",
      headers: {
        "Ocp-Apim-Subscription-Key": this.key,
        "Content-Type": "application/ssml+xml",
        "X-Microsoft-OutputFormat": "riff-24khz-16bit-mono-pcm",
        "User-Agent": "onboarding-assistant",
      },
      body: ssml,
    });
    if (!res.ok) throw new Error(`Azure TTS ${res.status}: ${await res.text()}`);
    const wav = Buffer.from(await res.arrayBuffer());
    return { wav, seconds: wavSeconds(wav) };
  }
}

/** No speech service configured: silent audio long enough to read the caption. */
export class SilentTts implements Tts {
  readonly voiced = false;

  async synthesize(text: string): Promise<Speech> {
    const words = text.trim().split(/\s+/).length;
    const seconds = Math.max(3, words / 2.4);
    return { wav: silentWav(seconds), seconds };
  }
}

export function wavSeconds(wav: Buffer): number {
  // Walk RIFF chunks to find "fmt " (byte rate) and "data" (size).
  let byteRate = SAMPLE_RATE * 2;
  for (let off = 12; off + 8 <= wav.length; ) {
    const id = wav.toString("ascii", off, off + 4);
    const size = wav.readUInt32LE(off + 4);
    if (id === "fmt ") byteRate = wav.readUInt32LE(off + 16);
    if (id === "data") return Math.min(size, wav.length - off - 8) / byteRate;
    off += 8 + size + (size % 2);
  }
  return 0;
}

export function silentWav(seconds: number, sampleRate = SAMPLE_RATE): Buffer {
  const dataSize = Math.round(seconds * sampleRate) * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataSize, 40);
  return buf;
}

export function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}
