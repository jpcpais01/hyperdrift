import { ENGINE_WORKLET } from '../src/audio/engineWorklet';
import type { EngineProfile } from '../src/audio/engineProfile';

type Proc = { process(i: unknown, o: Float32Array[][], p: Record<string, Float32Array>): boolean; port: { onmessage: ((e: { data: unknown }) => void) | null } };

/** Loads the worklet source with a minimal AudioWorkletGlobalScope shim. */
export function loadEngine(sr = 48000) {
  let Ctor: (new (o: unknown) => Proc) | null = null;
  class AudioWorkletProcessor {
    port = { onmessage: null as ((e: { data: unknown }) => void) | null, postMessage() {} };
  }
  new Function('AudioWorkletProcessor', 'registerProcessor', 'sampleRate', ENGINE_WORKLET)(
    AudioWorkletProcessor,
    (_n: string, c: new (o: unknown) => Proc) => (Ctor = c),
    sr,
  );
  return (profile: EngineProfile) => new Ctor!({ processorOptions: profile });
}

export interface Seg {
  seconds: number;
  rpm: number;
  throttle: number;
  nitro?: number;
  cut?: number;
  limiter?: number;
  pop?: number;
}

export function render(profile: EngineProfile, segs: Seg[], sr = 48000): Float32Array {
  const make = loadEngine(sr);
  const proc = make(profile);
  const total = Math.round(segs.reduce((a, s) => a + s.seconds, 0) * sr);
  const out = new Float32Array(total);
  let o = 0;
  for (const s of segs) {
    const blocks = Math.round((s.seconds * sr) / 128);
    if (s.pop) proc.port.onmessage?.({ data: { pop: s.pop } });
    for (let b = 0; b < blocks && o + 128 <= total; b++) {
      const buf = new Float32Array(128);
      proc.process([], [[buf]], {
        rpm: new Float32Array([s.rpm]),
        throttle: new Float32Array([s.throttle]),
        nitro: new Float32Array([s.nitro ?? 0]),
        cut: new Float32Array([s.cut ?? 0]),
        limiter: new Float32Array([s.limiter ?? 0]),
        pitch: new Float32Array([1]),
        gain: new Float32Array([1]),
      });
      out.set(buf, o);
      o += 128;
    }
  }
  return out;
}

export function stats(x: Float32Array, from = 0, to = x.length) {
  let sum = 0;
  let peak = 0;
  let finite = true;
  for (let i = from; i < to; i++) {
    const v = x[i];
    if (!Number.isFinite(v)) finite = false;
    sum += v * v;
    peak = Math.max(peak, Math.abs(v));
  }
  return { rms: Math.sqrt(sum / Math.max(1, to - from)), peak, finite };
}

export function wav(x: Float32Array, sr = 48000): Uint8Array {
  const buf = new ArrayBuffer(44 + x.length * 2);
  const v = new DataView(buf);
  const w = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF');
  v.setUint32(4, 36 + x.length * 2, true);
  w(8, 'WAVE');
  w(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sr, true);
  v.setUint32(28, sr * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  w(36, 'data');
  v.setUint32(40, x.length * 2, true);
  for (let i = 0; i < x.length; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, x[i])) * 32767, true);
  return new Uint8Array(buf);
}
