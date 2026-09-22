import type { Project } from '../types';
import type { Segment } from './coverage';

const EPS = 1e-6;

/** 持续发声疲劳的一段越界区间（半开 [start, end)）。 */
export interface FatigueSegment extends Segment {
  /** 该疲劳区间内累计连续发声达到的最大秒数（含期间短换气的暂停，累计不清零） */
  peakSinging: number;
}

/**
 * 规范化每位歌手的疲劳设置：只接受非负有限数（非法值一律回退 0 = 停用），
 * 并吸附到 0.1 秒。外部数据（导入 / 本地存储 / 快照）进入状态前必须经过本函数。
 */
export function normalizeSingerLimits(raw?: {
  maxSustainSec?: unknown;
  recoveryBreathSec?: unknown;
}): { maxSustainSec: number; recoveryBreathSec: number } {
  const nonNeg = (v: unknown) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) return 0;
    return Math.round(n * 10) / 10;
  };
  return {
    maxSustainSec: nonNeg(raw?.maxSustainSec),
    recoveryBreathSec: nonNeg(raw?.recoveryBreathSec),
  };
}

/**
 * 合并重叠或首尾相接（半开相邻）的换气区间：
 * 相邻换气之间没有任何发声，语义上属于同一次「不发声」。
 */
function mergeBreaths(breaths: Segment[], duration: number): Segment[] {
  const sorted = breaths
    .map((b) => ({
      start: Math.min(Math.max(0, b.start), duration),
      end: Math.min(Math.max(0, b.end), duration),
    }))
    .filter((b) => b.end - b.start > EPS)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const out: Segment[] = [];
  for (const b of sorted) {
    const last = out[out.length - 1];
    if (last && b.start <= last.end + EPS) last.end = Math.max(last.end, b.end);
    else out.push({ ...b });
  }
  return out;
}

/**
 * 扫描一位歌手的换气时间轴，计算「持续发声疲劳」区间。
 *
 * 语义（全程按半开区间 [start, end) 处理边界）：
 *  - 两次有效恢复之间的发声时间逐段累计；换气期间不发声，自然不增加累计；
 *  - 仅时长 ≥ recoveryThreshold 的换气算「有效恢复」：在换气开始时刻清零累计，
 *    此前若在疲劳标记中，标记段结束于该时刻（不含）；
 *  - 短换气（时长 < 恢复阈值）只暂停累计：换气结束后接着之前的累计继续；
 *  - 累计发声超过 maxSustain 的精确时刻起进入疲劳，持续标记到下一次有效恢复开始；
 *    若直到全曲结束都未恢复，则标记到 duration（不含）。
 *
 * maxSustain ≤ 0 表示停用检查（recoveryThreshold ≤ 0 表示任意换气都有效恢复）。
 */
export function singerFatigue(
  breaths: Segment[],
  maxSustain: number,
  recoveryThreshold: number,
  duration: number,
): FatigueSegment[] {
  if (!(duration > 0) || !(maxSustain > 0) || !Number.isFinite(maxSustain)) return [];
  const merged = mergeBreaths(breaths, duration);
  const out: FatigueSegment[] = [];

  let accumulated = 0; // 当前自上次有效恢复以来的累计发声秒数
  let cursor = 0; // 已处理到的时间
  let fatigueStart: number | null = null;
  /** 自疲劳开始以来累计发声的最大值（短换气只暂停、不清零） */
  let peakSinceFatigue = maxSustain;

  for (const b of merged) {
    const singEnd = b.start;
    const singLen = singEnd - cursor;
    if (singLen > EPS) {
      accumulated += singLen;
      if (fatigueStart === null && accumulated > maxSustain + EPS) {
        // 精确越界时刻 = 本次发声段起点 + 剩余额度
        fatigueStart = singEnd - (accumulated - maxSustain);
        peakSinceFatigue = accumulated;
      } else if (fatigueStart !== null) {
        peakSinceFatigue = Math.max(peakSinceFatigue, accumulated);
      }
    }

    const effective = recoveryThreshold <= 0 || b.end - b.start + EPS >= recoveryThreshold;
    if (effective) {
      if (fatigueStart !== null) {
        out.push({ start: fatigueStart, end: b.start, peakSinging: peakSinceFatigue });
        fatigueStart = null;
        peakSinceFatigue = maxSustain;
      }
      accumulated = 0;
    }
    cursor = b.end;
  }

  // 最后一次换气（或曲首）之后到曲终的发声段
  if (duration - cursor > EPS) {
    accumulated += duration - cursor;
    if (fatigueStart === null && accumulated > maxSustain + EPS) {
      fatigueStart = duration - (accumulated - maxSustain);
      peakSinceFatigue = accumulated;
    } else if (fatigueStart !== null) {
      peakSinceFatigue = Math.max(peakSinceFatigue, accumulated);
    }
  }
  if (fatigueStart !== null && duration - fatigueStart > EPS) {
    out.push({ start: fatigueStart, end: duration, peakSinging: peakSinceFatigue });
  }
  return out;
}

/** 一位歌手的疲劳检查结果（停用检查时 segs 为空）。 */
export interface SingerFatigue {
  singerId: string;
  name: string;
  partId: string;
  maxSustainSec: number;
  recoveryBreathSec: number;
  segs: FatigueSegment[];
}

/** 计算全曲所有歌手的疲劳区间（基于传入工程；预览时传入预览工程即可实时重算）。 */
export function projectFatigue(project: Project): Map<string, SingerFatigue> {
  const m = new Map<string, SingerFatigue>();
  for (const s of project.singers) {
    const segs = singerFatigue(s.breaths, s.maxSustainSec, s.recoveryBreathSec, project.duration);
    m.set(s.id, {
      singerId: s.id,
      name: s.name,
      partId: s.partId,
      maxSustainSec: s.maxSustainSec,
      recoveryBreathSec: s.recoveryBreathSec,
      segs,
    });
  }
  return m;
}

/** 侧栏汇总中的一条疲劳警示。 */
export interface FatigueAlert {
  singerId: string;
  name: string;
  partId: string;
  partName: string;
  start: number;
  end: number;
  peakSinging: number;
  maxSustainSec: number;
}

/**
 * 汇总全曲疲劳警示，按开始时间升序（同时刻按声部名、歌手名、结束时间），
 * 供侧栏列表与跳转使用。
 */
export function fatigueAlerts(project: Project, fatigue: Map<string, SingerFatigue>): FatigueAlert[] {
  const partName = new Map(project.parts.map((p) => [p.id, p.name]));
  const alerts: FatigueAlert[] = [];
  for (const f of fatigue.values()) {
    for (const seg of f.segs) {
      alerts.push({
        singerId: f.singerId,
        name: f.name,
        partId: f.partId,
        partName: partName.get(f.partId) ?? '',
        start: seg.start,
        end: seg.end,
        peakSinging: seg.peakSinging,
        maxSustainSec: f.maxSustainSec,
      });
    }
  }
  return alerts.sort(
    (a, b) =>
      a.start - b.start ||
      a.partName.localeCompare(b.partName, 'zh') ||
      a.name.localeCompare(b.name, 'zh') ||
      a.end - b.end,
  );
}

/** 疲劳警示跳转目标的 DOM id（时间轴警示层与侧栏列表共用，index 取自同一排序结果）。 */
export const fatigueDomId = (singerId: string, index: number) => `fatigue-${singerId}-${index}`;
