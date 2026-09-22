import type { BreathInterval, Project, RehearsalSnapshot, Singer, VoicePart } from '../types';
import { uid } from './id';

const EPS = 1e-6;
const SNAPSHOTS_KEY = 'breath-relay:snapshots:v1';

// ---------- 创建 / 恢复 ----------

/** 缺省快照名：排练快照 + 本地日期时间 */
export function defaultSnapshotName(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `排练快照 ${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}:${p(
    now.getMinutes(),
  )}`;
}

/**
 * 保存当前工程的排练快照：深拷贝冻结声部、歌手与换气区间，
 * 之后对工程的任何修改都不会影响已保存的快照。
 * 节拍图 / 曲名 / 全曲时长不在冻结范围内。
 */
export function createSnapshot(project: Project, name?: string, now: Date = new Date()): RehearsalSnapshot {
  const snap: RehearsalSnapshot = {
    id: uid(),
    name: name && name.trim() ? name.trim() : defaultSnapshotName(now),
    createdAt: now.getTime(),
    projectName: project.name,
    parts: JSON.parse(JSON.stringify(project.parts)) as VoicePart[],
    singers: JSON.parse(JSON.stringify(project.singers)) as Singer[],
  };
  return Object.freeze(snap);
}

/**
 * 恢复快照：用快照中的声部 / 歌手 / 换气区间整体替换当前工程，
 * 但保留当前工程的曲名、全曲时长与节拍图（节拍图不被快照覆盖）。
 */
export function restoreProjectSnapshot(project: Project, snapshot: RehearsalSnapshot): Project {
  return {
    ...project,
    parts: JSON.parse(JSON.stringify(snapshot.parts)) as VoicePart[],
    singers: JSON.parse(JSON.stringify(snapshot.singers)) as Singer[],
  };
}

// ---------- 差异 ----------

export type SnapshotDiffType = 'added' | 'removed' | 'moved' | 'duration';

/**
 * 当前工程相对快照的一条换气区间差异。
 * 对齐规则：先按歌手 ID 对齐当前工程与快照，再按区间 ID 对齐该歌手的区间。
 * 同一条区间同时发生起止移动与时长变化时，type 取 'moved'、durationChanged 为 true。
 */
export interface SnapshotDiffEntry {
  type: SnapshotDiffType;
  /** 差异排序与展示所用的时间：新增/移动/时长变化取当前起点，删除取原起点 */
  time: number;
  singerId: string;
  singerName: string;
  intervalId: string;
  /** 半开区间 [start, end)：新增/删除时只有一侧存在，移动/时长变化时两侧都在 */
  before?: { start: number; end: number };
  after?: { start: number; end: number };
  /** 起点是否发生变化（移动） */
  moved: boolean;
  /** 时长是否发生变化 */
  durationChanged: boolean;
}

const isZero = (x: number) => Math.abs(x) < EPS;
const entryTime = (e: SnapshotDiffEntry) => e.time;

/**
 * 计算当前工程与任一快照之间的换气区间差异（半开区间 [start, end) 语义）：
 *  - added：当前存在、快照中不存在（区间 ID 层面，或歌手在快照中不存在）；
 *  - removed：快照中存在、当前不存在；
 *  - moved / duration：ID 相同的区间，比较起点（移动）与终点（时长 = end − start）；
 * 结果按时间升序展示（同时刻按歌手名、终点排）。
 */
export function diffProjectSnapshot(
  project: Project,
  snapshot: RehearsalSnapshot,
): SnapshotDiffEntry[] {
  const curByName = new Map(project.singers.map((s) => [s.id, s]));
  const oldByName = new Map(snapshot.singers.map((s) => [s.id, s]));
  const singerIds = new Set<string>([...curByName.keys(), ...oldByName.keys()]);

  const out: SnapshotDiffEntry[] = [];
  for (const singerId of singerIds) {
    const cur = curByName.get(singerId);
    const old = oldByName.get(singerId);
    const singerName = cur?.name ?? old?.name ?? '未知歌手';

    const curMap = new Map<string, BreathInterval>((cur?.breaths ?? []).map((b) => [b.id, b]));
    const oldMap = new Map<string, BreathInterval>((old?.breaths ?? []).map((b) => [b.id, b]));
    const rangeOf = (b: BreathInterval) => ({ start: b.start, end: b.end });

    for (const [id, b] of curMap) {
      const ob = oldMap.get(id);
      if (!ob) {
        out.push(mkEntry('added', b.start, singerId, singerName, id, undefined, rangeOf(b), false, false));
        continue;
      }
      const moved = !isZero(b.start - ob.start);
      const durationChanged = !isZero(b.end - b.start - (ob.end - ob.start));
      if (!moved && !durationChanged) continue;
      // 起点变化（起止移动）归为 moved；起点不变、仅终点改变的纯时长变化归为 duration
      const type: SnapshotDiffType = moved ? 'moved' : 'duration';
      out.push(mkEntry(type, b.start, singerId, singerName, id, rangeOf(ob), rangeOf(b), moved, durationChanged));
    }
    for (const [id, b] of oldMap) {
      if (curMap.has(id)) continue;
      out.push(mkEntry('removed', b.start, singerId, singerName, id, rangeOf(b), undefined, false, false));
    }
  }

  return out.sort(
    (a, b) =>
      entryTime(a) - entryTime(b) ||
      a.singerName.localeCompare(b.singerName, 'zh') ||
      (a.after?.end ?? a.before?.end ?? 0) - (b.after?.end ?? b.before?.end ?? 0) ||
      a.type.localeCompare(b.type),
  );
}

function mkEntry(
  type: SnapshotDiffType,
  time: number,
  singerId: string,
  singerName: string,
  intervalId: string,
  before: { start: number; end: number } | undefined,
  after: { start: number; end: number } | undefined,
  moved: boolean,
  durationChanged: boolean,
): SnapshotDiffEntry {
  return { type, time, singerId, singerName, intervalId, before, after, moved, durationChanged };
}

/** 歌手层面的结构变化（区间差异之外的汇总信息）。 */
export interface SnapshotStructureDiff {
  addedSingers: string[];
  removedSingers: string[];
  addedParts: string[];
  removedParts: string[];
}

/** 统计快照与当前工程之间声部 / 歌手的增删（按 ID 对齐，名称取当前名）。 */
export function diffStructure(project: Project, snapshot: RehearsalSnapshot): SnapshotStructureDiff {
  const curSingers = new Map(project.singers.map((s) => [s.id, s]));
  const oldSingers = new Set(snapshot.singers.map((s) => s.id));
  const curParts = new Map(project.parts.map((p) => [p.id, p]));
  const oldParts = new Set(snapshot.parts.map((p) => p.id));
  return {
    addedSingers: project.singers.filter((s) => !oldSingers.has(s.id)).map((s) => s.name),
    removedSingers: snapshot.singers.filter((s) => !curSingers.has(s.id)).map((s) => s.name),
    addedParts: project.parts.filter((p) => !oldParts.has(p.id)).map((p) => p.name),
    removedParts: snapshot.parts
      .filter((p) => !curParts.has(p.id))
      .map((p) => curParts.get(p.id)?.name ?? p.name),
  };
}

// ---------- 持久化与数据清洗 ----------

const num = (v: unknown, fallback: number) =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback;
const str = (v: unknown, fallback: string) => (typeof v === 'string' && v ? v : fallback);

/** 清洗外部快照数据（localStorage / 手工导入），不合法返回 null。 */
export function sanitizeSnapshot(raw: unknown): RehearsalSnapshot | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (!Array.isArray(o.parts) || !Array.isArray(o.singers)) return null;

  const parts = (o.parts as unknown[])
    .map((rp) => {
      const p = rp as Record<string, unknown>;
      if (!p || typeof p !== 'object') return null;
      return {
        id: str(p.id, uid()),
        name: str(p.name, '声部'),
        color: str(p.color, '#60a5fa'),
        minSingers: Math.max(0, Math.round(num(p.minSingers, 1))),
      };
    })
    .filter((x): x is VoicePart => x !== null);
  if (parts.length === 0) return null;
  const partIds = new Set(parts.map((p) => p.id));

  const singers = (o.singers as unknown[])
    .map((rs) => {
      const s = rs as Record<string, unknown>;
      if (!s || typeof s !== 'object') return null;
      const partId = str(s.partId, '');
      if (!partIds.has(partId)) return null;
      const breaths = (Array.isArray(s.breaths) ? s.breaths : [])
        .map((rb) => {
          const b = rb as Record<string, unknown>;
          if (!b || typeof b !== 'object') return null;
          const start = num(b.start, NaN);
          const end = num(b.end, NaN);
          if (!Number.isFinite(start) || !Number.isFinite(end) || end - start <= EPS) return null;
          return { id: str(b.id, uid()), start, end };
        })
        .filter((x): x is BreathInterval => x !== null);
      return { id: str(s.id, uid()), name: str(s.name, '歌手'), partId, breaths };
    })
    .filter((x): x is Singer => x !== null);

  const createdAt = num(o.createdAt, NaN);
  const snap: RehearsalSnapshot = {
    id: str(o.id, uid()),
    name: str(o.name, defaultSnapshotName()),
    createdAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
    projectName: str(o.projectName, '未命名曲目'),
    parts,
    singers,
  };
  return snap;
}

export function loadSnapshots(): RehearsalSnapshot[] {
  try {
    const raw = localStorage.getItem(SNAPSHOTS_KEY);
    if (!raw) return [];
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) return [];
    return list
      .map((x) => sanitizeSnapshot(x))
      .filter((x): x is RehearsalSnapshot => x !== null)
      .sort((a, b) => b.createdAt - a.createdAt);
  } catch {
    return [];
  }
}

export function saveSnapshots(snapshots: RehearsalSnapshot[]): void {
  try {
    localStorage.setItem(SNAPSHOTS_KEY, JSON.stringify(snapshots));
  } catch {
    // 存储满或被禁用时静默失败
  }
}
