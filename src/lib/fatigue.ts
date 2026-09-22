import type { FatigueSettings, Project, Singer } from '../types';
import type { Segment } from './coverage';

const EPS = 1e-6;

/** 停用状态的疲劳设置（0/0）：旧工程缺省与非法值的统一回退。 */
export const DISABLED_FATIGUE: FatigueSettings = { maxSingSeconds: 0, recoveryBreathSeconds: 0 };

/** 非负有限秒数；负数或非有限值一律归 0（不进入状态）。 */
const nonNeg = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;

/** 清洗外部数据中的疲劳设置：缺字段补 0（停用），负数 / NaN / Infinity 归 0。 */
export function sanitizeFatigue(raw: unknown): FatigueSettings {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    maxSingSeconds: nonNeg(o.maxSingSeconds),
    recoveryBreathSeconds: nonNeg(o.recoveryBreathSeconds),
  };
}

/** 该歌手是否启用了疲劳检查（两项设置均 > 0；任一为 0 即停用）。 */
export function fatigueEnabled(s: Singer): boolean {
  return s.fatigue.maxSingSeconds > 0 && s.fatigue.recoveryBreathSeconds > 0;
}

/** 一段「持续发声超限」警示：半开区间 [start, end)。 */
export interface FatigueSegment extends Segment {
  /** 警示期间累计连续发声的峰值秒数（必然 > 上限） */
  peakSeconds: number;
}

/**
 * 扫描一位歌手的全曲，计算持续发声超限的警示时段（半开区间语义）：
 *  - 换气区间 [start, end) 内不发声，累计暂停；
 *  - 时长达到 recoveryBreathSeconds 的换气为「有效恢复」：累计清零，
 *    进行中的警示在该换气的起点结束；
 *  - 较短的换气只暂停累计、不清零，警示跨过它继续标记；
 *  - 累计连续发声超过 maxSingSeconds 时，从精确越界时刻（累计恰好达到上限的瞬间）
 *    开始标记，直到下一次有效恢复开始；若直到曲终都没有有效恢复，则标记到全曲结束。
 */
export function singerFatigueSegments(
  breaths: Segment[],
  maxSingSeconds: number,
  recoveryBreathSeconds: number,
  duration: number,
): FatigueSegment[] {
  if (duration <= 0 || maxSingSeconds <= 0 || recoveryBreathSeconds <= 0) return [];

  const sorted = breaths
    .map((b) => ({
      start: Math.min(Math.max(0, b.start), duration),
      end: Math.min(Math.max(0, b.end), duration),
    }))
    .filter((b) => b.end - b.start > EPS)
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const out: FatigueSegment[] = [];
  let accum = 0; // 当前累计连续发声秒数（自上次有效恢复起）
  let t = 0; // 扫描游标
  let warnStart: number | null = null; // 进行中警示的起点（精确越界时刻）

  // 在 [t, to] 内持续发声：累计增长，越界瞬间记录警示起点
  const sing = (to: number) => {
    if (to - t <= EPS) return;
    const after = accum + (to - t);
    if (warnStart === null && after > maxSingSeconds + EPS) {
      warnStart = t + Math.max(0, maxSingSeconds - accum);
    }
    accum = after;
  };

  const closeWarning = (end: number) => {
    if (warnStart !== null && end - warnStart > EPS) {
      out.push({ start: warnStart, end, peakSeconds: accum });
    }
    warnStart = null;
  };

  for (const b of sorted) {
    sing(b.start);
    if (b.end - b.start >= recoveryBreathSeconds - EPS) {
      // 有效恢复：警示在其起点结束，累计清零
      closeWarning(b.start);
      accum = 0;
    }
    // 较短换气：只暂停（游标越过该区间），累计保持
    t = Math.max(t, b.end);
  }
  sing(duration);
  closeWarning(duration);

  return out;
}

/** 某歌手当前的疲劳警示时段（未启用时为空数组）。 */
export function singerFatigue(singer: Singer, duration: number): FatigueSegment[] {
  return singerFatigueSegments(
    singer.breaths,
    singer.fatigue.maxSingSeconds,
    singer.fatigue.recoveryBreathSeconds,
    duration,
  );
}

/** 全工程所有歌手的疲劳警示，按歌手 ID 索引（未启用的歌手为空数组）。 */
export function projectFatigue(project: Project): Map<string, FatigueSegment[]> {
  const m = new Map<string, FatigueSegment[]>();
  for (const s of project.singers) m.set(s.id, singerFatigue(s, project.duration));
  return m;
}

/** 侧栏汇总条目：警示时段 + 歌手 / 声部信息。 */
export interface FatigueSummaryEntry extends FatigueSegment {
  singerId: string;
  singerName: string;
  partId: string;
  partName: string;
  partColor: string;
}

/**
 * 汇总全部歌手的疲劳警示，按开始时间升序（同时刻按歌手名、终点排）。
 * fatigue 一般来自 projectFatigue（预览时基于预览工程计算），名称取自 project。
 */
export function fatigueSummary(
  project: Project,
  fatigue: Map<string, FatigueSegment[]>,
): FatigueSummaryEntry[] {
  const partById = new Map(project.parts.map((p) => [p.id, p]));
  const out: FatigueSummaryEntry[] = [];
  for (const s of project.singers) {
    const segs = fatigue.get(s.id) ?? [];
    if (segs.length === 0) continue;
    const part = partById.get(s.partId);
    for (const seg of segs) {
      out.push({
        ...seg,
        singerId: s.id,
        singerName: s.name,
        partId: s.partId,
        partName: part?.name ?? '声部',
        partColor: part?.color ?? '#60a5fa',
      });
    }
  }
  return out.sort(
    (a, b) =>
      a.start - b.start ||
      a.singerName.localeCompare(b.singerName, 'zh') ||
      a.end - b.end,
  );
}
