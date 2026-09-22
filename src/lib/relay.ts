import type { BeatMap, Project } from '../types';
import type { Segment } from './coverage';
import { beatToTime } from './tempo';
import { uid } from './id';

const EPS = 1e-6;

/** 声部接力排程的输入：在 [startBeat, endBeat) 拍域内为声部每位歌手各安排一段换气。 */
export interface RelayRequest {
  partId: string;
  /** 起始绝对拍（0 起算，含） */
  startBeat: number;
  /** 结束绝对拍（0 起算，不含）：换气段终点须落在该拍 */
  endBeat: number;
  /** 每位歌手新换气的拍数（正整数） */
  breathBeats: number;
}

/** 一位歌手的接力换气安排（同时给出拍位与换算后的秒区间，跨变速点也精确）。 */
export interface RelayAssignment {
  singerId: string;
  /** 换气起始绝对拍（整数拍，0 起算，含） */
  startBeat: number;
  /** 换气拍数 */
  breathBeats: number;
  start: number;
  end: number;
}

export interface RelaySuccess {
  ok: true;
  partId: string;
  /** 拍域换算到秒后的窗口（用于高亮） */
  windowStart: number;
  windowEnd: number;
  assignments: RelayAssignment[];
}

/** 失败原因分两类：某位歌手在拍域内没有任何可用拍位，或满足不了声部门槛。 */
export interface RelayFailure {
  ok: false;
  reason: 'no-slot' | 'coverage';
  partId: string;
  /** no-slot 时：无可用拍位的歌手名 */
  singers: string[];
  /** 人话提示 */
  message: string;
}

export type RelayResult = RelaySuccess | RelayFailure;

interface Candidate {
  /** 起始绝对拍 */
  beat: number;
  seg: Segment;
}

const overlaps = (a: Segment, b: Segment) => a.start < b.end - EPS && b.start < a.end - EPS;

/** 统计窗口 [winStart, winEnd) 内任意时刻同时换气的最大人数（半开区间语义）。 */
function maxConcurrent(intervals: Segment[], winStart: number, winEnd: number): number {
  const events: { t: number; d: number }[] = [];
  for (const iv of intervals) {
    const s = Math.max(iv.start, winStart);
    const e = Math.min(iv.end, winEnd);
    if (e - s <= EPS) continue;
    events.push({ t: s, d: 1 }, { t: e, d: -1 });
  }
  events.sort((a, b) => a.t - b.t || a.d - b.d); // 同一时刻先结束后开始
  let cur = 0;
  let max = 0;
  for (const ev of events) {
    cur += ev.d;
    max = Math.max(max, cur);
  }
  return max;
}

/**
 * 声部接力排程（回溯搜索）：
 * 为声部每位歌手在给定拍域内各安排一段长度为 breathBeats 拍的新换气，要求同时满足：
 *  1. 区间不越出拍域窗口（也不越出全曲 [0, duration]）；
 *  2. 不与该歌手已有换气段重叠（相邻相接允许）；
 *  3. 窗口内任意时刻同时换气人数不超过「歌手总数 − 最低发声人数」
 *     （等价于发声人数始终不低于声部门槛）。
 *
 * 候选位置按整拍枚举（跨变速点时由 beatMap 分段换算为秒），用回溯 + 最少候选优先
 * （MRV）求一组可行解；搜索不动工程，结果整组预览、确认后一次性写入。
 */
export function planRelay(project: Project, req: RelayRequest): RelayResult {
  const part = project.parts.find((p) => p.id === req.partId);
  const singers = project.singers.filter((s) => s.partId === req.partId);
  if (!part || singers.length === 0) {
    return {
      ok: false,
      reason: 'coverage',
      partId: req.partId,
      singers: [],
      message: '该声部没有歌手，无法安排接力。',
    };
  }

  const startBeat = Math.round(req.startBeat);
  const endBeat = Math.round(req.endBeat);
  const breathBeats = Math.round(req.breathBeats);
  if (
    !Number.isFinite(startBeat) ||
    !Number.isFinite(endBeat) ||
    !Number.isFinite(breathBeats) ||
    startBeat < 0 ||
    breathBeats < 1 ||
    endBeat - startBeat < breathBeats
  ) {
    return {
      ok: false,
      reason: 'no-slot',
      partId: part.id,
      singers: singers.map((s) => s.name),
      message: '拍域无效：起止拍位或每人换气拍数不合法（窗口至少要能放下一次换气）。',
    };
  }

  const beatMap: BeatMap = project.beatMap;
  const winStart = beatToTime(startBeat, beatMap);
  const winEnd = beatToTime(endBeat, beatMap);

  if (singers.length < part.minSingers) {
    return {
      ok: false,
      reason: 'coverage',
      partId: part.id,
      singers: [],
      message: `覆盖门槛冲突：声部只有 ${singers.length} 人，低于最低发声 ${part.minSingers} 人的门槛，任何换气都会不达标。`,
    };
  }

  // 每位歌手枚举窗口内所有整拍候选，再按自身已有换气与全曲边界过滤
  const candidateSets: { singerId: string; cands: Candidate[] }[] = singers.map((s) => {
    const cands: Candidate[] = [];
    for (let b = startBeat; b + breathBeats <= endBeat; b++) {
      const seg = { start: beatToTime(b, beatMap), end: beatToTime(b + breathBeats, beatMap) };
      if (seg.start < -EPS || seg.end > project.duration + EPS) continue; // 不越全曲
      if (s.breaths.some((o) => overlaps(seg, o))) continue; // 不撞自身已有换气
      cands.push({ beat: b, seg });
    }
    return { singerId: s.id, cands };
  });

  const empty = candidateSets.filter((c) => c.cands.length === 0);
  if (empty.length > 0) {
    const names = empty.map((c) => singers.find((s) => s.id === c.singerId)!.name);
    return {
      ok: false,
      reason: 'no-slot',
      partId: part.id,
      singers: names,
      message: `歌手无可用拍位：${names.join('、')} 在所选拍域内找不到不越窗且不与已有换气重叠的 ${breathBeats} 拍位置。`,
    };
  }

  const threshold = singers.length - part.minSingers; // 允许同时换气的最大人数

  // 窗口内已有的换气（本声部）若已超标，追加接力换气不可能修复
  const existingInWindow = singers
    .flatMap((s) => s.breaths)
    .filter((b) => b.start < winEnd - EPS && b.end > winStart + EPS);
  if (maxConcurrent(existingInWindow, winStart, winEnd) > threshold) {
    return {
      ok: false,
      reason: 'coverage',
      partId: part.id,
      singers: [],
      message:
        '覆盖门槛冲突：拍域内已有的换气安排在某些时刻已使发声人数低于门槛，请先调整已有换气段或放宽门槛。',
    };
  }

  // 回溯：最少候选歌手优先（MRV），候选按起点升序 → 解确定且尽量从窗口前段开始接力
  const order = candidateSets
    .map((c) => ({ singerId: c.singerId, cands: c.cands }))
    .sort(
      (a, b) =>
        a.cands.length - b.cands.length ||
        a.cands[0].seg.start - b.cands[0].seg.start ||
        a.singerId.localeCompare(b.singerId),
    );

  const placed = new Map<string, Candidate>();
  const placedSegs: Segment[] = [];

  const dfs = (idx: number): boolean => {
    if (idx === order.length) return true;
    const { singerId, cands } = order[idx];
    for (const cand of cands) {
      // 加入候选后窗口内同时换气人数仍不得超标
      if (maxConcurrent([...existingInWindow, ...placedSegs, cand.seg], winStart, winEnd) > threshold) continue;
      placed.set(singerId, cand);
      placedSegs.push(cand.seg);
      if (dfs(idx + 1)) return true;
      placedSegs.pop();
      placed.delete(singerId);
    }
    return false;
  };

  if (!dfs(0)) {
    return {
      ok: false,
      reason: 'coverage',
      partId: part.id,
      singers: [],
      message:
        '覆盖门槛冲突：所有歌手都有可用拍位，但无法为每位歌手同时安排换气而始终保证发声人数不低于门槛；请扩大拍域、缩短每人换气拍数或降低门槛。',
    };
  }

  const assignments: RelayAssignment[] = singers.map((s) => {
    const cand = placed.get(s.id)!;
    return {
      singerId: s.id,
      startBeat: cand.beat,
      breathBeats,
      start: cand.seg.start,
      end: cand.seg.end,
    };
  });

  return { ok: true, partId: part.id, windowStart: winStart, windowEnd: winEnd, assignments };
}

/** 把接力排程结果一次性写入工程（为每位歌手追加一段新换气），返回新工程。 */
export function applyRelay(project: Project, result: RelaySuccess): Project {
  const bySinger = new Map(result.assignments.map((a) => [a.singerId, a]));
  return {
    ...project,
    singers: project.singers.map((s) => {
      const a = bySinger.get(s.id);
      if (!a) return s;
      return { ...s, breaths: [...s.breaths, { id: uid(), start: a.start, end: a.end }] };
    }),
  };
}
