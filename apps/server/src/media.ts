import { createReadStream } from 'node:fs';
import { mkdir, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const AUDIO_MIME_TYPES = ['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/wav', 'audio/x-wav'] as const;

const extensionByMime: Record<string, string> = {
  'audio/webm': '.webm',
  'audio/ogg': '.ogg',
  'audio/mp4': '.m4a',
  'audio/mpeg': '.mp3',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
};

type AudioKind = 'webm' | 'ogg' | 'mp4' | 'mpeg' | 'wav';

function startsWith(buffer: Buffer, bytes: number[]) {
  return bytes.every((byte, index) => buffer[index] === byte);
}

function detectAudioKind(buffer: Buffer): AudioKind | null {
  if (startsWith(buffer, [0x1a, 0x45, 0xdf, 0xa3])) return 'webm';
  if (buffer.subarray(0, 4).toString('ascii') === 'OggS') return 'ogg';
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WAVE') return 'wav';
  if (buffer.subarray(4, 8).toString('ascii') === 'ftyp') return 'mp4';
  if (buffer.subarray(0, 3).toString('ascii') === 'ID3') return 'mpeg';
  if (buffer.length > 1 && buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0) return 'mpeg';
  return null;
}

export function validateAudio(buffer: Buffer, declaredMime: string): { mimeType: string; extension: string } | null {
  const normalized = declaredMime.toLowerCase().split(';')[0].trim();
  const extension = extensionByMime[normalized];
  if (!extension) return null;
  const detected = detectAudioKind(buffer);
  if (!detected) return null;
  const expected: Record<string, AudioKind> = {
    '.webm': 'webm',
    '.ogg': 'ogg',
    '.m4a': 'mp4',
    '.mp3': 'mpeg',
    '.wav': 'wav',
  };
  if (expected[extension] !== detected) return null;
  return { mimeType: normalized, extension };
}

export function safeFilename(mimeType: string) {
  return `voice-message${extensionByMime[mimeType] || '.bin'}`;
}

export class LocalMediaStorage {
  private readonly baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = path.resolve(baseDir);
  }

  async init() {
    await mkdir(this.baseDir, { recursive: true });
  }

  private resolveKey(storageKey: string) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,180}$/.test(storageKey) || storageKey.includes('..')) {
      throw new Error('Invalid storage key');
    }
    const resolved = path.resolve(this.baseDir, storageKey);
    if (!resolved.startsWith(`${this.baseDir}${path.sep}`)) throw new Error('Invalid storage key');
    return resolved;
  }

  async save(storageKey: string, data: Buffer) {
    const target = this.resolveKey(storageKey);
    await writeFile(target, data, { flag: 'wx' });
    return target;
  }

  async stat(storageKey: string) {
    return stat(this.resolveKey(storageKey));
  }

  stream(storageKey: string, range?: { start: number; end: number }) {
    return createReadStream(this.resolveKey(storageKey), range);
  }

  async remove(storageKey: string) {
    await unlink(this.resolveKey(storageKey)).catch(() => undefined);
  }
}
