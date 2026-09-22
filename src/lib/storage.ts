import type { BeatMap, Project } from '../types';
import { uid } from './id';
import { normalizeBeatMap } from './tempo';
import { sanitizeFatigue } from './fatigue';

export { uid };

const KEY = 'breath-relay:project:v1';

/** 清洗时只要求是普通对象，字段合法性交给 normalizeBeatMap。 */
type BeatMapShape = Partial<BeatMap> | null | undefined;

const num = (v: unknown, fallback: number) =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback;
const str = (v: unknown, fallback: string) => (typeof v === 'string' && v ? v : fallback);

/** 校验并清洗外部数据（localStorage / 导入的 JSON），不合法则返回 null。 */
export function sanitizeProject(raw: unknown): Project | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Record<string, unknown>;
  if (!Array.isArray(p.parts) || !Array.isArray(p.singers)) return null;

  const duration = Math.max(1, num(p.duration, 96));
  const parts = (p.parts as unknown[])
    .map((rp) => {
      const o = rp as Record<string, unknown>;
      if (!o || typeof o !== 'object') return null;
      return {
        id: str(o.id, uid()),
        name: str(o.name, '声部'),
        color: str(o.color, '#60a5fa'),
        minSingers: Math.max(0, Math.round(num(o.minSingers, 1))),
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);
  if (parts.length === 0) return null;

  const partIds = new Set(parts.map((pt) => pt.id));
  const singers = (p.singers as unknown[])
    .map((rs) => {
      const o = rs as Record<string, unknown>;
      if (!o || typeof o !== 'object') return null;
      const partId = str(o.partId, '');
      if (!partIds.has(partId)) return null;
      const breaths = (Array.isArray(o.breaths) ? o.breaths : [])
        .map((rb) => {
          const b = rb as Record<string, unknown>;
          if (!b || typeof b !== 'object') return null;
          const start = Math.min(Math.max(0, num(b.start, 0)), duration);
          const end = Math.min(Math.max(0, num(b.end, 0)), duration);
          if (end - start <= 0) return null;
          return { id: str(b.id, uid()), start, end };
        })
        .filter((x): x is NonNullable<typeof x> => x !== null);
      // 旧工程缺少疲劳设置时补 0/0（停用）；负数 / 非有限值归 0
      return { id: str(o.id, uid()), name: str(o.name, '歌手'), partId, breaths, fatigue: sanitizeFatigue(o.fatigue) };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  // 旧工程缺少节拍图字段时使用默认 4/4、120 BPM
  const beatMap = normalizeBeatMap((p.beatMap as BeatMapShape) ?? undefined);

  return { name: str(p.name, '未命名曲目'), duration, beatMap, parts, singers };
}

export function loadProject(): Project | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? sanitizeProject(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

export function saveProject(p: Project): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    // 存储满或被禁用时静默失败
  }
}

export function clearSavedProject(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // ignore
  }
}
