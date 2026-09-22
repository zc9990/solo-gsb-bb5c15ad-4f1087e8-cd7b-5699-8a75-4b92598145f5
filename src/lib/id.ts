/** 轻量唯一 id 生成器（独立模块，避免 storage ↔ tempo 循环依赖）。 */
export function uid(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}
