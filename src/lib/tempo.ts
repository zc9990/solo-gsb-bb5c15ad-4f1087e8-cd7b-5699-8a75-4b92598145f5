import type { BeatMap, TempoChange } from '../types';
import { uid } from './id';

/** 旧工程缺少节拍图时的默认值：4/4、120 BPM。 */
export const DEFAULT_BEAT_MAP: BeatMap = { beatsPerBar: 4, beatUnit: 4, startBpm: 120, changes: [] };

const round1 = (v: number) => Math.round(v * 10) / 10;

/** 清洗外部节拍图数据：拍号/BPM 取合法范围；变速点按拍位排序、去重（同拍位保留首个）。 */
export function normalizeBeatMap(raw?: Partial<BeatMap> | null): BeatMap {
  const int = (v: unknown, lo: number, hi: number, fb: number) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) && n >= lo && n <= hi ? n : fb;
  };
  const num = (v: unknown, lo: number, hi: number, fb: number) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= lo && n <= hi ? n : fb;
  };

  const beatsPerBar = int(raw?.beatsPerBar, 1, 16, 4);
  const beatUnit = int(raw?.beatUnit, 1, 16, 4);
  let startBpm = round1(num(raw?.startBpm, 1, 999, 120));

  const list = (Array.isArray(raw?.changes) ? raw!.changes : [])
    .map((c) => {
      if (!c || typeof c !== 'object') return null;
      const o = c as unknown as Record<string, unknown>;
      const measure = int(o.measure, 1, 100000, NaN);
      const bpm = round1(num(o.bpm, 1, 999, NaN));
      if (!Number.isFinite(measure) || !Number.isFinite(bpm)) return null;
      return { id: typeof o.id === 'string' && o.id ? o.id : uid(), measure, bpm };
    })
    .filter((x): x is TempoChange => x !== null)
    .sort((a, b) => a.measure - b.measure);

  // measure=1 的条目即起始 BPM；其余条目按拍位去重（同小节保留首个）
  const changes: TempoChange[] = [];
  for (const c of list) {
    if (c.measure === 1) {
      startBpm = c.bpm;
      continue;
    }
    if (!changes.some((x) => x.measure === c.measure)) changes.push(c);
  }
  return { beatsPerBar, beatUnit, startBpm, changes };
}

/** 把给定的修改应用到节拍图上，并保证结果规范化。 */
export function updateBeatMap(beatMap: BeatMap, patch: Partial<BeatMap>): BeatMap {
  return normalizeBeatMap({ ...beatMap, ...patch });
}

/** 新增 / 修改变速点：返回 null 表示拍位重复或不合法。 */
export function setTempoChange(beatMap: BeatMap, measure: number, bpm: number, id?: string): BeatMap | null {
  const m = Math.round(Number(measure));
  if (!Number.isFinite(m) || m < 2) return null;
  if (beatMap.changes.some((c) => c.measure === m && c.id !== id)) return null;
  const b = Number(bpm);
  if (!Number.isFinite(b) || b < 1 || b > 999) return null;
  const changes = beatMap.changes
    .filter((c) => c.id !== id)
    .concat([{ id: id ?? uid(), measure: m, bpm: round1(b) }]);
  return { ...beatMap, changes };
}

export function removeTempoChange(beatMap: BeatMap, id: string): BeatMap {
  return { ...beatMap, changes: beatMap.changes.filter((c) => c.id !== id) };
}

/** 下一个尚无变速点的小节号（用于「添加变速点」按钮）。 */
export function nextFreeMeasure(beatMap: BeatMap): number {
  const used = new Set(beatMap.changes.map((c) => c.measure));
  let m = 2;
  while (used.has(m)) m++;
  return m;
}

// ---------- 分段恒速换算 ----------

export interface TempoSegment {
  /** 该段起始的绝对拍（0 起算） */
  beat: number;
  /** 该段起始的秒 */
  time: number;
  bpm: number;
}

/** 展开为「绝对拍起点 + 秒起点 + BPM」的分段表。 */
export function tempoSegments(beatMap: BeatMap): TempoSegment[] {
  const bpb = beatMap.beatsPerBar;
  const segs: TempoSegment[] = [{ beat: 0, time: 0, bpm: beatMap.startBpm }];
  for (const c of beatMap.changes) {
    const beat = (c.measure - 1) * bpb;
    const prev = segs[segs.length - 1];
    const time = prev.time + ((beat - prev.beat) * 60) / prev.bpm;
    segs.push({ beat, time, bpm: c.bpm });
  }
  return segs;
}

/** 绝对拍（从 0 起算的浮点拍） → 秒。 */
export function beatToTime(beat: number, beatMap: BeatMap): number {
  const segs = tempoSegments(beatMap);
  let s = segs[0];
  for (const seg of segs) {
    if (seg.beat <= beat) s = seg;
    else break;
  }
  return s.time + ((beat - s.beat) * 60) / s.bpm;
}

/** 秒 → 绝对拍（浮点）。变速点恰好落在分段边界上。 */
export function timeToBeat(time: number, beatMap: BeatMap): number {
  const segs = tempoSegments(beatMap);
  let s = segs[0];
  for (const seg of segs) {
    if (seg.time <= time) s = seg;
    else break;
  }
  return s.beat + ((time - s.time) * s.bpm) / 60;
}

export interface BeatLocation {
  /** 小节号（1 起算） */
  measure: number;
  /** 小节内第几拍（1 起算，可为小数） */
  beatInBar: number;
  /** 绝对拍（0 起算） */
  absolute: number;
}

/** 秒 → 小节/拍位置。 */
export function timeToLocation(time: number, beatMap: BeatMap): BeatLocation {
  const absolute = Math.max(0, timeToBeat(time, beatMap));
  const bpb = beatMap.beatsPerBar;
  const measure = Math.floor(absolute / bpb) + 1;
  return { measure, beatInBar: absolute - (measure - 1) * bpb + 1, absolute };
}

/** 把任意秒吸附到最近的整拍（跨变速点时先换算到拍域再取整、再换回秒）。 */
export function snapTimeToBeat(time: number, beatMap: BeatMap): number {
  return beatToTime(Math.round(timeToBeat(time, beatMap)), beatMap);
}

/** 小节号/小节内拍（均 1 起算）→ 秒。 */
export function measureBeatToTime(measure: number, beatInBar: number, beatMap: BeatMap): number {
  return beatToTime((measure - 1) * beatMap.beatsPerBar + (beatInBar - 1), beatMap);
}

// ---------- 标尺 ----------

export interface BeatTick {
  beat: number;
  time: number;
  measure: number;
  beatInBar: number;
  downbeat: boolean;
  bpm: number;
  tempoChange: boolean;
}

/** 生成 [0, duration] 内的逐拍标尺刻度，并标注每拍所处速度与变速点。 */
export function beatTicks(beatMap: BeatMap, duration: number): BeatTick[] {
  const bpb = beatMap.beatsPerBar;
  const segs = tempoSegments(beatMap);
  const out: BeatTick[] = [];
  let si = 0;
  for (let beat = 0; beat < 20000; beat++) {
    while (si + 1 < segs.length && segs[si + 1].beat <= beat) si++;
    const seg = segs[si];
    const time = seg.time + ((beat - seg.beat) * 60) / seg.bpm;
    if (time > duration + 1e-9) break;
    const measure = Math.floor(beat / bpb) + 1;
    out.push({
      beat,
      time,
      measure,
      beatInBar: beat - (measure - 1) * bpb + 1,
      downbeat: beat % bpb === 0,
      bpm: seg.bpm,
      tempoChange: seg.beat === beat,
    });
  }
  return out;
}

/** 拍位置格式化：`小节:拍`，非整拍保留两位小数。 */
export function fmtLocation(loc: BeatLocation): string {
  const b = Math.round(loc.beatInBar * 100) / 100;
  return `${loc.measure}:${Number.isInteger(b) ? b : b.toFixed(2)}`;
}

/** 秒 → `小节:拍`。 */
export function fmtTimeAsBeat(time: number, beatMap: BeatMap): string {
  return fmtLocation(timeToLocation(time, beatMap));
}
