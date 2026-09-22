/** 秒 → "12.5s" */
export function fmtSec(t: number): string {
  return `${(Math.round(t * 10) / 10).toFixed(1)}s`;
}

/** 秒 → 时间轴刻度文本（超过一分钟用 m:ss） */
export function fmtTick(t: number): string {
  const m = Math.floor(t / 60);
  const s = t % 60;
  return m > 0 ? `${m}:${String(s).padStart(2, '0')}` : `${s}s`;
}

/** 位移 → "+3s" / "-2s" / "0s" */
export function fmtOffset(k: number): string {
  return k > 0 ? `+${k}s` : `${k}s`;
}

export function fmtClock(d: Date): string {
  return d.toLocaleTimeString('zh-CN', { hour12: false });
}
