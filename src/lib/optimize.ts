import type { Project } from '../types';
import { partUnder, projectUnderSeconds, totalSeconds, underCoveredSegments } from './coverage';

export interface MoveCandidate {
  /** 整数秒位移（正为向后/更晚，负为向前/更早） */
  offset: number;
  start: number;
  end: number;
  /** 应用该位移后的全曲未达标总秒数 */
  underSeconds: number;
}

export interface OptimizeResult {
  singerId: string;
  intervalId: string;
  range: number;
  /** 修复前的全曲未达标总秒数 */
  baseline: number;
  /** 最优候选（按 未达标总秒数 → |位移| → 更早时刻 排序） */
  best: MoveCandidate;
  /** 位移为 0 的候选（即当前位置） */
  current: MoveCandidate;
  /** 全部可行候选，已按目标排序 */
  candidates: MoveCandidate[];
  infeasible: { bounds: number; overlap: number };
}

const overlaps = (aS: number, aE: number, bS: number, bE: number) =>
  aS < bE - 1e-9 && bS < aE - 1e-9;

/**
 * 对指定换气段，在 ±range 秒的整数位移内穷举：
 * 保持时长不变、不越出全曲、不与该歌手其它换气段重叠。
 * 目标依次：最小化全曲未达标总秒数 → 最小化位移量 → 平局取更早时刻。
 */
export function findBestMove(
  project: Project,
  singerId: string,
  intervalId: string,
  range: number,
): OptimizeResult | null {
  const singer = project.singers.find((s) => s.id === singerId);
  if (!singer) return null;
  const interval = singer.breaths.find((b) => b.id === intervalId);
  if (!interval) return null;
  const part = project.parts.find((p) => p.id === singer.partId);
  if (!part) return null;

  const dur = interval.end - interval.start;
  const ownOthers = singer.breaths.filter((b) => b.id !== intervalId);

  const baseline = projectUnderSeconds(project);

  // 其它声部的未达标秒数不受本次移动影响，只计算一次
  const otherPartsSeconds = project.parts
    .filter((p) => p.id !== singer.partId)
    .reduce((acc, p) => acc + totalSeconds(partUnder(project, p.id)), 0);
  const partSingers = project.singers.filter((s) => s.partId === singer.partId);
  const othersBreaths = partSingers.filter((s) => s.id !== singerId).flatMap((s) => s.breaths);

  const candidates: MoveCandidate[] = [];
  let bounds = 0;
  let overlap = 0;
  for (let k = -range; k <= range; k++) {
    const start = interval.start + k;
    const end = start + dur;
    if (start < -1e-9 || end > project.duration + 1e-9) {
      bounds++;
      continue;
    }
    if (ownOthers.some((o) => overlaps(start, end, o.start, o.end))) {
      overlap++;
      continue;
    }
    const underSeconds =
      otherPartsSeconds +
      totalSeconds(
        underCoveredSegments(
          [...othersBreaths, { start, end }],
          partSingers.length,
          part.minSingers,
          project.duration,
        ),
      );
    candidates.push({ offset: k, start, end, underSeconds });
  }

  candidates.sort(
    (a, b) =>
      a.underSeconds - b.underSeconds ||
      Math.abs(a.offset) - Math.abs(b.offset) ||
      a.offset - b.offset, // 平局取更早时刻
  );

  const best = candidates[0];
  const current = candidates.find((c) => c.offset === 0);
  if (!best || !current) return null; // 位移 0 必然可行，理论上不会走到这里
  return {
    singerId,
    intervalId,
    range,
    baseline,
    best,
    current,
    candidates,
    infeasible: { bounds, overlap },
  };
}

/** 返回应用了指定位移后的新工程（不可变更新）。 */
export function applyMove(project: Project, singerId: string, intervalId: string, offset: number): Project {
  return {
    ...project,
    singers: project.singers.map((s) =>
      s.id !== singerId
        ? s
        : {
            ...s,
            breaths: s.breaths.map((b) =>
              b.id !== intervalId ? b : { ...b, start: b.start + offset, end: b.end + offset },
            ),
          },
    ),
  };
}
