// Web Audio 捕捉とお手本再生(ARCHITECTURE.md「データフローとスレッドモデル」参照)。
// AudioWorklet はブロック転送のみ(DSPを置かない)→ pitchWorker(Web Worker)で YIN 実行。
import type { RawPitchSample } from '../core/types';

export interface CaptureInfo {
  contextSampleRate: number;
  internalSampleRate: number;
  /** getUserMedia constraints の実適用結果(Phase 0.5 の検証対象) */
  trackSettings: MediaTrackSettings;
}

export type PitchCallback = (sample: RawPitchSample) => void;
export type ErrorCallback = (message: string) => void;

/** Level 4「うたのフレーズ」お手本メロディの1音。TRAINING_MODEL.md「Level 4」参照。 */
export interface MelodyNote {
  hz: number;
  durationMs: number;
  /** この音の後に置く無音ギャップ(ms)。曲内の最終音では使われない(次の音が無いため)。 */
  gapAfterMs: number;
}

/**
 * 各音の開始オフセット(ms、先頭音=0)を純関数で計算する(M-6設計判断: 呼び出し側=UIが
 * 「♪3/7 ソ『み』」の表示同期に使えるよう公開する。playMelody自身もこれで絶対時刻を組み立てるため、
 * 表示とAudioContextスケジューリングが同じ計算式を共有し、ズレない)。
 * MelodyNoteをplatform層(このファイル)に置いたため、スケジュール計算も同じファイルに置く
 * (core/へ型を分割するとplatform→core→platformの行き来が増えるだけで得るものがない — 詳細は最終報告)。
 */
export function melodySchedule(notes: MelodyNote[]): number[] {
  const offsets: number[] = [];
  let t = 0;
  for (const note of notes) {
    offsets.push(t);
    t += note.durationMs + note.gapAfterMs;
  }
  return offsets;
}

// worklet はバンドラ非依存にするためインラインコード + Blob URL で登録する
const WORKLET_CODE = `
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buf = new Float32Array(4096);
    this._len = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch && ch.length > 0) {
      if (this._len + ch.length <= this._buf.length) {
        this._buf.set(ch, this._len);
        this._len += ch.length;
      }
      // 512フレーム(48kHzで約10.7ms)ごとにメインへ転送
      if (this._len >= 512) {
        const out = this._buf.slice(0, this._len);
        this.port.postMessage(out.buffer, [out.buffer]);
        this._len = 0;
      }
    }
    return true;
  }
}
registerProcessor('capture-processor', CaptureProcessor);
`;

interface WorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  terminate(): void;
  onmessage: ((e: MessageEvent) => void) | null;
}

/** 録音タップの上限(較正・回帰ハーネス用。長時間録音でメモリを圧迫しないための実装都合の値)。 */
const RECORDING_MAX_SECONDS = 60;

export class AudioSession {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private silentGain: GainNode | null = null;
  private worker: WorkerLike | null = null;

  // --- 録音タップ(較正の再現性の要。ROADMAP.md Phase 1 宿題) ---
  private recording = false;
  private recordedChunks: Float32Array[] = [];
  private recordedSampleCount = 0;
  private recordingSampleRate = 0;
  private recordingStartPerfMs: number | null = null;

  get running(): boolean {
    return this.stream !== null;
  }

  /**
   * 録音タップの有効/無効を切り替える。有効化のたびに新規録音として蓄積バッファをリセットする
   * (直前の録音を getRecording() で取り出していなければ失われる — 手動録音開始/停止トグルの
   * 「毎回新しい録音を始める」という直感に合わせた仕様)。
   * 上限 RECORDING_MAX_SECONDS(60秒)超過時点で録音を自動停止する(仕様上「超過分を古い方から
   * 捨てる」か「停止」のどちらでもよいとされており、実装が単純で事故りにくい後者を採用)。
   */
  setRecording(enabled: boolean): void {
    if (enabled) {
      this.recordedChunks = [];
      this.recordedSampleCount = 0;
      this.recordingSampleRate = 0;
      this.recordingStartPerfMs = performance.now();
    }
    this.recording = enabled;
  }

  /** 蓄積済みの録音を取り出す。録音していなければ null。 */
  getRecording(): { sampleRate: number; pcm: Float32Array } | null {
    if (this.recordedChunks.length === 0) return null;
    const pcm = new Float32Array(this.recordedSampleCount);
    let offset = 0;
    for (const chunk of this.recordedChunks) {
      pcm.set(chunk, offset);
      offset += chunk.length;
    }
    return { sampleRate: this.recordingSampleRate, pcm };
  }

  /**
   * 直近の setRecording(true) 時点の performance.now()(録音サンプル0の壁時計時刻の近似)。
   * ループバック遅延測定(DebugPage)専用。録音していなければ null。
   */
  getRecordingStartTime(): number | null {
    return this.recordingStartPerfMs;
  }

  /** 録音タップへブロックを1つ蓄積する(呼び出し側で既にコピー済みのFloat32Arrayを渡すこと)。 */
  private captureRecordingChunk(chunk: Float32Array): void {
    if (this.recordingSampleRate === 0 && this.ctx) {
      this.recordingSampleRate = this.ctx.sampleRate;
    }
    const capSamples = Math.floor(RECORDING_MAX_SECONDS * this.recordingSampleRate);
    const remaining = capSamples - this.recordedSampleCount;
    if (remaining <= 0) {
      this.recording = false;
      return;
    }
    const toAdd = chunk.length <= remaining ? chunk : chunk.subarray(0, remaining);
    this.recordedChunks.push(toAdd);
    this.recordedSampleCount += toAdd.length;
    if (toAdd.length < chunk.length) {
      this.recording = false; // ちょうど上限に達した
    }
  }

  /** 必ずユーザー操作(タップ)ハンドラ内から呼ぶこと(自動再生制限) */
  async start(onPitch: PitchCallback, onError: ErrorCallback): Promise<CaptureInfo> {
    if (!window.isSecureContext) {
      throw new Error('secure context ではないためマイクを使えません(https で開いてください)');
    }
    this.stop();

    const ctx = new AudioContext();
    await ctx.resume();
    this.ctx = ctx;

    // ブラウザ前処理の無効化を「要求」。実際に適用されたかは getSettings() で読み戻す(AUDIO_ANALYSIS.md §1)
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
      },
    });
    this.stream = stream;
    const trackSettings = stream.getAudioTracks()[0]?.getSettings() ?? {};

    const workletUrl = URL.createObjectURL(new Blob([WORKLET_CODE], { type: 'application/javascript' }));
    try {
      await ctx.audioWorklet.addModule(workletUrl);
    } finally {
      URL.revokeObjectURL(workletUrl);
    }

    const worker = new Worker(new URL('./pitchWorker.ts', import.meta.url), {
      type: 'module',
    }) as unknown as WorkerLike;
    this.worker = worker;
    worker.onmessage = (e: MessageEvent) => {
      const msg = e.data as { type: string; sample?: RawPitchSample; message?: string };
      if (msg.type === 'pitch' && msg.sample) onPitch(msg.sample);
      else if (msg.type === 'error') onError(msg.message ?? 'worker error');
    };
    worker.postMessage({ type: 'init', contextSampleRate: ctx.sampleRate });

    const node = new AudioWorkletNode(ctx, 'capture-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
    });
    this.workletNode = node;
    node.port.onmessage = (e: MessageEvent) => {
      const buffer = e.data as ArrayBuffer;
      // 録音タップ: postMessage の transfer は buffer を neuter する(以降アクセス不可になる)ため、
      // 録音用コピーは必ず worker へ転送する前に取る(順序が逆だとneuter後の空配列を蓄積してしまう)。
      if (this.recording) {
        this.captureRecordingChunk(new Float32Array(buffer).slice());
      }
      // ArrayBuffer をそのまま worker へ転送(コピーなし)
      this.worker?.postMessage({ type: 'block', buffer }, [buffer]);
    };

    const source = ctx.createMediaStreamSource(stream);
    this.sourceNode = source;
    source.connect(node);
    // worklet を駆動し続けるため無音で destination へ接続(フィードバック防止に gain 0)
    const silent = ctx.createGain();
    silent.gain.value = 0;
    this.silentGain = silent;
    node.connect(silent).connect(ctx.destination);

    return {
      contextSampleRate: ctx.sampleRate,
      internalSampleRate: ctx.sampleRate / 2,
      trackSettings,
    };
  }

  stop(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.sourceNode?.disconnect();
    this.sourceNode = null;
    this.workletNode?.disconnect();
    this.workletNode = null;
    this.silentGain?.disconnect();
    this.silentGain = null;
    this.worker?.terminate();
    this.worker = null;
    void this.ctx?.close();
    this.ctx = null;
    // ブロックがもう届かないためタップを止める。蓄積済みバッファは意図的にクリアしない
    // (マイク停止後も getRecording() / WAVダウンロードで取り出せるようにするため)。
    this.recording = false;
  }

  /**
   * お手本音の再生(サイン波+明示的リリース — 残響を残さない。AUDIO_ANALYSIS.md §7)。
   * 捕捉していない状態でも単独で使える。
   * 契約: **鳴り終わった時点で resolve する**(engine はこれを起点にガード区間を取る — レビューM-6)。
   */
  async playTone(hz: number, durationMs: number): Promise<void> {
    const ctx = this.ctx ?? new AudioContext();
    await ctx.resume();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const t0 = ctx.currentTime;
    const attackS = 0.02;
    const releaseS = 0.15;
    const sustainS = Math.max(durationMs / 1000 - attackS - releaseS, 0.05);
    // お手本音色: 純サイン波→倍音付き(基音1.0+2倍音0.4+3倍音0.2)。純音は音高知覚が
    // 不安定で高め/低めに歌いやすい(2026-08-16 ユーザーの+70cent傾向を受けて変更 —
    // AUDIO_ANALYSIS.md §7)。PeriodicWaveは既定で正規化されるため音量は安全
    const wave = ctx.createPeriodicWave(
      new Float32Array([0, 0, 0, 0]),
      new Float32Array([0, 1, 0.4, 0.2]),
    );
    osc.setPeriodicWave(wave);
    osc.frequency.value = hz;
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(0.35, t0 + attackS);
    gain.gain.setValueAtTime(0.35, t0 + attackS + sustainS);
    gain.gain.linearRampToValueAtTime(0, t0 + attackS + sustainS + releaseS);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + attackS + sustainS + releaseS + 0.01);
    await new Promise<void>((resolve) => {
      osc.onended = () => resolve();
    });
    if (ctx !== this.ctx) void ctx.close();
  }

  /**
   * お手本メロディの再生(Level 4「うたのフレーズ」)。1本のAudioContextタイムラインへ
   * **絶対時刻で全音をスケジュール**する(逐次awaitはジッタで曲に聞こえない — レビューM-6)。
   * 音色はplayToneと同じ(基音+倍音のPeriodicWave、attack/releaseエンベロープ)。
   * PeriodicWaveは1つ生成して全オシレータで共有する(Web Audio APIの仕様上、波形データを
   * 複数オシレータへ適用しても相互に干渉しない — 生成コストを削減する)。
   * 契約: playTone同様、**最後の音の鳴り終わりで resolve する**(呼び出し側はこれを起点に
   * ガード区間を取れる)。
   */
  async playMelody(notes: MelodyNote[]): Promise<void> {
    if (notes.length === 0) return;
    const ctx = this.ctx ?? new AudioContext();
    await ctx.resume();
    const offsets = melodySchedule(notes);
    const attackS = 0.02;
    const releaseS = 0.08;
    const t0 = ctx.currentTime;
    const wave = ctx.createPeriodicWave(
      new Float32Array([0, 0, 0, 0]),
      new Float32Array([0, 1, 0.4, 0.2]),
    );

    let lastOsc: OscillatorNode | null = null;
    let lastGain: GainNode | null = null;
    notes.forEach((note, i) => {
      const startS = t0 + offsets[i] / 1000;
      const sustainS = Math.max(note.durationMs / 1000 - attackS - releaseS, 0.02);
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.setPeriodicWave(wave);
      osc.frequency.value = note.hz;
      gain.gain.setValueAtTime(0, startS);
      gain.gain.linearRampToValueAtTime(0.35, startS + attackS);
      gain.gain.setValueAtTime(0.35, startS + attackS + sustainS);
      gain.gain.linearRampToValueAtTime(0, startS + attackS + sustainS + releaseS);
      osc.connect(gain).connect(ctx.destination);
      osc.start(startS);
      osc.stop(startS + attackS + sustainS + releaseS + 0.01);
      // 終了済みノードをグラフに蓄積させない(Codexレビュー低: 「もう一回」連打での蓄積防止)。
      // 最後の音は下のPromise側で disconnect+resolve をまとめて行う(onended上書き競合の防止)
      osc.onended = () => {
        osc.disconnect();
        gain.disconnect();
      };
      lastOsc = osc;
      lastGain = gain;
    });

    await new Promise<void>((resolve) => {
      if (!lastOsc || !lastGain) {
        resolve();
        return;
      }
      const osc = lastOsc;
      const gain = lastGain;
      osc.onended = () => {
        osc.disconnect();
        gain.disconnect();
        resolve();
      };
    });
    if (ctx !== this.ctx) void ctx.close();
  }

  /**
   * ループバック遅延測定用の短いクリック音(矩形バースト)を再生する。
   * envelope をかけず立ち上がりを鋭くする(録音タップ側のRMS急増検出をしやすくする狙い)。
   * playTone 同様、鳴り終わった時点で resolve する契約。
   */
  async playClick(durationMs = 5): Promise<void> {
    const ctx = this.ctx ?? new AudioContext();
    await ctx.resume();
    const n = Math.max(1, Math.round((durationMs / 1000) * ctx.sampleRate));
    const buffer = ctx.createBuffer(1, n, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    data.fill(0.9);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(ctx.destination);
    src.start();
    await new Promise<void>((resolve) => {
      src.onended = () => resolve();
    });
    if (ctx !== this.ctx) void ctx.close();
  }
}
