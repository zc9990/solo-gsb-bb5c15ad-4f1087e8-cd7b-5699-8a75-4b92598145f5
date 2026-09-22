import { underCoveredSegments, totalSeconds, mergeSegments } from '../src/lib/coverage';
import { findBestMove } from '../src/lib/optimize';
import { createSampleProject } from '../src/lib/sample';
import {
  beatTicks,
  beatToTime,
  fmtLocation,
  measureBeatToTime,
  normalizeBeatMap,
  snapTimeToBeat,
  timeToBeat,
  timeToLocation,
  updateBeatMap,
} from '../src/lib/tempo';
import { placeNewIntervalOnBeat } from '../src/lib/constraints';
import { applyRelay, planRelay } from '../src/lib/relay';
import {
  createSnapshot,
  defaultSnapshotName,
  diffProjectSnapshot,
  diffStructure,
  loadSnapshots,
  restoreProjectSnapshot,
  sanitizeSnapshot,
  saveSnapshots,
} from '../src/lib/snapshot';
import type { Project } from '../src/types';
import { uid } from '../src/lib/id';

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`PASS ${name}`);
  } else {
    failures++;
    console.log(`FAIL ${name}\n  expected: ${e}\n  actual:   ${a}`);
  }
}

function near(name: string, actual: number, expected: number, eps = 1e-9) {
  check(name, Math.abs(actual - expected) < eps, true);
}

// 1. 半开区间相邻不重叠：[0,2) 与 [2,4) 同一时刻最多 1 人换气 → 2 人声部 min 1 达标
check('half-open adjacency', underCoveredSegments([{ start: 0, end: 2 }, { start: 2, end: 4 }], 2, 1, 10), []);

// 2. 合并相接的不足时段：3 人 min 2（允许 1 人换气），[0,2)[1,3)[2,4) → [1,3)
{
  const segs = underCoveredSegments(
    [{ start: 0, end: 2 }, { start: 1, end: 3 }, { start: 2, end: 4 }],
    3, 2, 10,
  );
  check('merge touching', segs.map((s) => [s.start, s.end]), [[1, 3]]);
  check('merge stats', [segs[0].minSinging, segs[0].deficit], [1, 1]);
}

// 3. 歌手总数低于最低要求 → 全曲不足
{
  const segs = underCoveredSegments([], 1, 2, 10);
  check('always short', segs.map((s) => [s.start, s.end, s.deficit]), [[0, 10, 1]]);
}

// 4. minSingers = 0 → 无要求
check('no requirement', underCoveredSegments([{ start: 0, end: 5 }], 1, 0, 10), []);

// 5. 示例工程基线：女高 4s + 女低 5s + 男高 2s = 11s
{
  const p = createSampleProject();
  const perPart = p.parts.map((part) => {
    const breaths = p.singers.filter((s) => s.partId === part.id).flatMap((s) => s.breaths);
    const n = p.singers.filter((s) => s.partId === part.id).length;
    return totalSeconds(underCoveredSegments(breaths, n, part.minSingers, p.duration));
  });
  check('sample per-part under', perPart, [4, 5, 2, 0]);
  check('sample baseline', perPart.reduce((a, b) => a + b, 0), 11);
}

// 6. 寻优：李雪 [19,22) ±10 → 最优 +2s，全曲未达标 11 → 9
{
  const p = createSampleProject();
  const li = p.singers.find((s) => s.name === '李雪')!;
  const iv = li.breaths[0]; // [19,22)
  const r = findBestMove(p, li.id, iv.id, 10)!;
  check('optimize baseline', r.baseline, 11);
  check('optimize best offset', r.best.offset, 2);
  check('optimize best under', r.best.underSeconds, 9);
  check('optimize best range', [r.best.start, r.best.end], [21, 24]);
  check('optimize current', r.current.offset, 0);
}

// 7. 寻优平局取更早时刻：赵敏 [44,46) ±10 → -2 与 +3 同为 9s，|−2| 更小 → -2
{
  const p = createSampleProject();
  const zhao = p.singers.find((s) => s.name === '赵敏')!;
  const iv = zhao.breaths[0]; // [44,46)
  const r = findBestMove(p, zhao.id, iv.id, 10)!;
  check('tie-break offset', r.best.offset, -2);
  check('tie-break under', r.best.underSeconds, 9);
}

// 8. 寻优不重叠约束：移动后不得与同歌手其它区间重叠（王芳 [18,21) 不能移到 [44,47) 附近）
{
  const p = createSampleProject();
  const wang = p.singers.find((s) => s.name === '王芳')!;
  const iv = wang.breaths[0]; // [18,21)
  const r = findBestMove(p, wang.id, iv.id, 30)!;
  const overlaps = (aS: number, aE: number, bS: number, bE: number) => aS < bE && bS < aE;
  const bad = r.candidates.filter((c) =>
    wang.breaths.filter((b) => b.id !== iv.id).some((o) => overlaps(c.start, c.end, o.start, o.end)),
  );
  check('no-overlap candidates', bad.length, 0);
  check('overlap skipped counted', r.infeasible.overlap > 0, true);
}

// 9. 边界：区间不能移出 [0, duration)
{
  const p = createSampleProject();
  const zheng = p.singers.find((s) => s.name === '郑伟')!;
  const iv = zheng.breaths[0]; // [10,13)
  const r = findBestMove(p, zheng.id, iv.id, 20)!;
  const out = r.candidates.filter((c) => c.start < 0 || c.end > p.duration);
  check('bounds respected', out.length, 0);
  check('bounds skipped counted', r.infeasible.bounds > 0, true);
}

// 10. mergeSegments 基本行为
check(
  'mergeSegments',
  mergeSegments([{ start: 5, end: 6 }, { start: 1, end: 2 }, { start: 2, end: 3 }, { start: 2.5, end: 4 }]),
  [{ start: 1, end: 4 }, { start: 5, end: 6 }],
);

// ---------- 节拍图：默认值、拍↔秒换算、跨变速点吸附 ----------

// 11. 旧工程缺少节拍图 → 默认 4/4、120 BPM（每拍 0.5s、每小节 2s）
check('default beatmap', normalizeBeatMap(undefined), {
  beatsPerBar: 4,
  beatUnit: 4,
  startBpm: 120,
  changes: [],
});

{
  const bm = normalizeBeatMap(undefined);
  near('constant beatToTime beat0', beatToTime(0, bm), 0);
  near('constant beatToTime beat4', beatToTime(4, bm), 2); // 第 2 小节首拍
  near('constant beatToTime beat12', beatToTime(12, bm), 6);
  near('constant timeToBeat 3s', timeToBeat(3, bm), 6);
  check('constant location 0', fmtLocation(timeToLocation(0, bm)), '1:1');
  check('constant location 2s', fmtLocation(timeToLocation(2, bm)), '2:1');
  check('constant location 3.5s', fmtLocation(timeToLocation(3.5, bm)), '2:4');
}

// 12. 分段恒速：4/4，第 3 小节首拍（绝对拍 8，t=4s）从 120 → 60 BPM
{
  const bm = normalizeBeatMap({ startBpm: 120, changes: [{ id: uid(), measure: 3, bpm: 60 }] });
  near('tempo change at beat 8', timeToBeat(4, bm), 8);
  near('post-change 1 beat = 1s: t=5 → beat9', timeToBeat(5, bm), 9);
  near('post-change beat10 → t=6', beatToTime(10, bm), 6);
  // 第 4 小节首拍 = 绝对拍 12 = 4 + 4*1 = 8s
  near('bar4 downbeat at 8s', measureBeatToTime(4, 1, bm), 8);
  check('location at 8s', fmtLocation(timeToLocation(8, bm)), '4:1');
  // 换算可逆
  near('roundtrip t=7.3', beatToTime(timeToBeat(7.3, bm), bm), 7.3);
}

// 13. 跨变速点吸附：t=3.9（变速前 120）最近拍是 4.0（变速点本身）；t=4.4（变速后 60）最近拍是 5.0
{
  const bm = normalizeBeatMap({ startBpm: 120, changes: [{ id: uid(), measure: 3, bpm: 60 }] });
  near('snap just before change', snapTimeToBeat(3.9, bm), 4);
  near('snap just after change', snapTimeToBeat(4.6, bm), 5); // beat 8.6 → 9
  near('snap mid post-segment', snapTimeToBeat(6.6, bm), 7); // 最近拍 11 → t=7
}

// 14. 变速点规范化：按拍位排序、重复拍位保留首个；measure=1 并入起始 BPM
{
  const bm = normalizeBeatMap({
    startBpm: 100,
    changes: [
      { id: 'b', measure: 5, bpm: 140 },
      { id: 'a', measure: 3, bpm: 80 },
      { id: 'dup', measure: 3, bpm: 200 },
      { id: 'one', measure: 1, bpm: 110 },
    ],
  });
  check('sorted unique changes', bm.changes.map((c) => [c.measure, c.bpm]), [[3, 80], [5, 140]]);
  check('measure1 folds into startBpm', bm.startBpm, 110);
  // 非法字段回退默认
  const junk = normalizeBeatMap({ beatsPerBar: 99, beatUnit: 0, startBpm: -5, changes: [{ measure: 0 }] });
  check('junk beatmap sanitized', junk, { beatsPerBar: 4, beatUnit: 4, startBpm: 120, changes: [] });
}

// 15. 编辑节拍图后已有换气段秒位置不变，仅拍位重新显示
{
  const p = createSampleProject();
  const before = JSON.stringify(p.singers.map((s) => s.breaths));
  const edited = { ...p, beatMap: updateBeatMap(p.beatMap, { startBpm: 60 }) };
  const after = JSON.stringify(edited.singers.map((s) => s.breaths));
  check('breath seconds untouched by beatmap edit', after, before);
  // 王芳首段 [18,21)：120 BPM 时起点为 10:1；改成 60 BPM 后为 5:3
  check('beat display at 120bpm', fmtLocation(timeToLocation(18, p.beatMap)), '10:1');
  check('beat display at 60bpm', fmtLocation(timeToLocation(18, edited.beatMap)), '5:3');
}

// 16. 按拍放置新换气段：跨变速点仍落在整拍；默认一个小节时长（拍数）
{
  const bm = normalizeBeatMap({ startBpm: 120, changes: [{ id: uid(), measure: 3, bpm: 60 }] });
  // 变速点在 t=4。双击 t=3.0 → 起点 3s（拍6），放 4 拍跨变速：拍 6→10 = 3s→6s
  const seg = placeNewIntervalOnBeat(3.0, [], 20, bm)!;
  near('on-beat start', seg.start, 3);
  near('on-beat end across change', seg.end, 6);
  near('start on integer beat', timeToBeat(seg.start, bm), 6);
  near('end on integer beat', timeToBeat(seg.end, bm), 10);

  // 空隙不足一小节：缩短到放得下的整拍数
  const tight = placeNewIntervalOnBeat(0, [{ start: 2, end: 20 }], 20, bm)!;
  near('tight start', tight.start, 0);
  near('tight end', tight.end, 2); // 4 拍 × 0.5s
  check('tight endpoints integer beats', [
    Number.isInteger(timeToBeat(tight.start, bm)),
    Number.isInteger(timeToBeat(tight.end, bm)),
  ], [true, true]);

  // 空隙小于最小长度 → null
  check('too-small gap', placeNewIntervalOnBeat(0, [{ start: 0.3, end: 20 }], 20, bm), null);
}

// 17. beatTicks 标注变速点：t=4 的刻度标记 tempoChange 且 bpm=60
{
  const bm = normalizeBeatMap({ startBpm: 120, changes: [{ id: uid(), measure: 3, bpm: 60 }] });
  const ticks = beatTicks(bm, 8);
  const at4 = ticks.find((tk) => Math.abs(tk.time - 4) < 1e-9)!;
  check('tick tempoChange flag', at4.tempoChange, true);
  check('tick bpm after change', at4.bpm, 60);
  check('tick measure after change', at4.measure, 3);
  check('first tick flag', ticks[0].tempoChange, true);
}

// ---------- 声部接力排程：回溯搜索、整组约束、两类无解 ----------

/** 构造恒速（或给定节拍图）测试工程：每位歌手的已有换气以 [start,end) 秒给出。 */
function relayProject(
  breaths: [number, number][][],
  opts: { minSingers?: number; duration?: number; bpm?: number; changes?: { measure: number; bpm: number }[] } = {},
): Project {
  const bpm = opts.bpm ?? 120;
  const bm = normalizeBeatMap(
    opts.changes ? { startBpm: bpm, changes: opts.changes.map((c) => ({ id: uid(), ...c })) } : { startBpm: bpm },
  );
  const part = { id: 'p1', name: '测试声部', color: '#60a5fa', minSingers: opts.minSingers ?? 1 };
  return {
    name: 'relay-test',
    duration: opts.duration ?? 60,
    beatMap: bm,
    parts: [part],
    singers: breaths.map((bs, i) => ({
      id: `s${i}`,
      name: `歌手${i + 1}`,
      partId: 'p1',
      breaths: bs.map(([start, end]) => ({ id: uid(), start, end })),
    })),
  };
}

const beatTimes = (p: Project, beats: number[]) => beats.map((b) => beatToTime(b, p.beatMap));

// 18. 基本可行：3 人声部门槛 2（最多同时 1 人换气），拍域 8 拍每人 2 拍 → 阶梯接力
{
  const p = relayProject([[], [], []], { minSingers: 2, bpm: 120 }); // 每拍 0.5s
  const r = planRelay(p, { partId: 'p1', startBeat: 0, endBeat: 8, breathBeats: 2 });
  check('relay feasible', r.ok, true);
  if (r.ok) {
    const starts = r.assignments.map((a) => a.startBeat).sort((x, y) => x - y);
    check('relay staggered beats', starts, [0, 2, 4]);
    check('relay times', r.assignments.map((a) => [a.start, a.end]).sort((x, y) => x[0] - y[0]), [
      [0, 1],
      [1, 2],
      [2, 3],
    ]);
    // 每人恰好新增一段，且都落在拍域窗口内
    check(
      'relay in-window',
      r.assignments.every((a) => a.start >= r.windowStart - 1e-9 && a.end <= r.windowEnd + 1e-9),
      true,
    );
  }
}

// 19. 不与歌手已有换气重叠：已有换气堵死窗口 → no-slot，并指出具体歌手
{
  // 窗口拍 0–6（0–3s），每段 2 拍；歌手1 的 [0.5,2.5) 与窗口内全部两个候选 [0,1)/[2,3) 都撞
  const p = relayProject([[[0.5, 2.5]]], { minSingers: 1, bpm: 120 });
  const r = planRelay(p, { partId: 'p1', startBeat: 0, endBeat: 6, breathBeats: 2 });
  check('relay no-slot reason', r.ok ? null : r.reason, 'no-slot');
  check('relay no-slot singer', r.ok ? null : r.singers, ['歌手1']);
}

// 20. 覆盖门槛冲突：2 人门槛 2（任何人换气都会低于门槛）→ coverage
{
  const p = relayProject([[], []], { minSingers: 2, bpm: 120 });
  const r = planRelay(p, { partId: 'p1', startBeat: 0, endBeat: 8, breathBeats: 2 });
  check('relay coverage reason', r.ok ? null : r.reason, 'coverage');
}

// 21. 覆盖门槛冲突：单人有位但整体排不下 —— 3 人门槛 2（最多 1 人换气），窗口仅 4 拍每人 2 拍
{
  const p = relayProject([[], [], []], { minSingers: 2, bpm: 120 });
  const r = planRelay(p, { partId: 'p1', startBeat: 0, endBeat: 4, breathBeats: 2 });
  check('relay window-too-tight', r.ok, false);
  check('relay tight reason', r.ok ? null : r.reason, 'coverage');
}

// 22. 门槛放宽后同一拍域有解：3 人门槛 1（最多 2 人同时换气），窗口 4 拍每人 2 拍
//     → 前两人同在 [0,1)，第三人 [1,2)，始终至少 1 人发声
{
  const p = relayProject([[], [], []], { minSingers: 1, bpm: 120 });
  const r = planRelay(p, { partId: 'p1', startBeat: 0, endBeat: 4, breathBeats: 2 });
  check('relay tight ok with lower threshold', r.ok, true);
  if (r.ok) {
    const [t0, t2] = beatTimes(p, [0, 2]);
    check(
      'relay lower-threshold packing',
      r.assignments.map((a) => [a.start, a.end]).sort((x, y) => x[0] - y[0]),
      [
        [t0, t0 + 1],
        [t0, t0 + 1],
        [t2, t2 + 1],
      ],
    );
  }
}

// 23. 跨变速点按拍枚举再换算秒：120 BPM、第 3 小节首拍（拍8, t=4）变 60；
//     窗口拍 6–12、每人 2 拍，2 人声部门槛 1
{
  const p = relayProject([[], []], {
    minSingers: 1,
    duration: 30,
    changes: [{ measure: 3, bpm: 60 }],
  });
  const r = planRelay(p, { partId: 'p1', startBeat: 6, endBeat: 12, breathBeats: 2 });
  check('relay across tempo ok', r.ok, true);
  if (r.ok) {
    // 候选从拍 6 起：拍6→3s、拍8→4s（变速点）、拍10→6s
    const starts = r.assignments.map((a) => a.startBeat).sort((x, y) => x - y);
    check('relay across tempo beats', starts, [6, 8]);
    const a0 = r.assignments.find((a) => a.startBeat === 6)!;
    const a1 = r.assignments.find((a) => a.startBeat === 8)!;
    near('relay pre-change seconds', a0.start, 3);
    near('relay pre-change end at tempo point', a0.end, 4); // 拍6→8 全在变速前：3→4s
    near('relay post-change seconds', a1.start, 4);
    near('relay post-change end', a1.end, 6); // 60 BPM：2 拍 = 2s
    // [3,4) 与 [4,6) 半开相邻不重叠 → 门槛 1 下任意时刻都至少 1 人发声
    const overlap = a0.start < a1.end - 1e-9 && a1.start < a0.end - 1e-9;
    check('relay respects threshold across change', overlap, false);
  }
}

// 24. 窗口越过全曲时长：候选全部越界 → no-slot
{
  const p = relayProject([[], []], { minSingers: 1, duration: 3, bpm: 120 }); // 全曲仅到拍 6
  const r = planRelay(p, { partId: 'p1', startBeat: 8, endBeat: 16, breathBeats: 2 });
  check('relay beyond duration no-slot', r.ok ? null : r.reason, 'no-slot');
}

// 25. 拍域内已有换气已使门槛超标 → coverage（提示先调整已有换气）
{
  // 3 人声部门槛 2（最多 1 人换气），窗口内歌手1、歌手2 已在同一时刻换气
  const p = relayProject([[[1, 2]], [[1, 2]], []], { minSingers: 2, bpm: 120 });
  const r = planRelay(p, { partId: 'p1', startBeat: 0, endBeat: 8, breathBeats: 1 });
  check('relay existing-overload coverage', r.ok ? null : r.reason, 'coverage');
}

// 26. 搜索不修改原工程；applyRelay 每人恰好追加一段；取消即原工程不变
{
  const p = relayProject([[], []], { minSingers: 1, bpm: 120 });
  const snapshot = JSON.stringify(p);
  const r = planRelay(p, { partId: 'p1', startBeat: 0, endBeat: 8, breathBeats: 2 });
  check('relay plan is pure', JSON.stringify(p), snapshot);
  if (r.ok) {
    const next = applyRelay(p, r);
    check(
      'relay apply adds one each',
      next.singers.map((s) => s.breaths.length),
      [1, 1],
    );
    check('relay apply keeps original untouched', p.singers.every((s) => s.breaths.length === 0), true);
    // 写入内容与预览一致
    check(
      'relay apply matches preview',
      next.singers
        .map((s) => s.breaths[0])
        .map((b) => [b.start, b.end])
        .sort((x, y) => x[0] - y[0]),
      r.assignments
        .map((a) => [a.start, a.end])
        .sort((x, y) => x[0] - y[0]),
    );
  }
}

// ---------- 排练快照：冻结、按歌手 ID 对齐的区间差异、恢复、清洗与持久化 ----------

/** 复制工程并按 id 覆盖 / 增删歌手换气，便于构造差异场景。 */
function withBreaths(p: Project, singerId: string, breaths: [number, number][]): Project {
  return {
    ...p,
    singers: p.singers.map((s) =>
      s.id !== singerId
        ? s
        : { ...s, breaths: breaths.map(([start, end]) => ({ id: uid(), start, end })) },
    ),
  };
}

/** 用既有区间 id 覆盖单个区间（用于移动 / 时长差异）。 */
function updateBreath(p: Project, singerId: string, intervalId: string, start: number, end: number): Project {
  return {
    ...p,
    singers: p.singers.map((s) =>
      s.id !== singerId
        ? s
        : { ...s, breaths: s.breaths.map((b) => (b.id !== intervalId ? b : { ...b, start, end })) },
    ),
  };
}

// 27. 快照冻结：保存后修改 / 删除工程中的声部歌手与区间，快照内容不变（深拷贝）
{
  const p = relayProject([[[1, 3]], [[5, 7]]], { minSingers: 1, bpm: 120 });
  const snap = createSnapshot(p, '排练前');
  let changed: Project = {
    ...p,
    parts: p.parts.map((pt) => (pt.id === 'p1' ? { ...pt, name: '改名声部' } : pt)),
    singers: p.singers.map((s, i) => (i === 0 ? { ...s, name: '改名歌手' } : s)),
  };
  changed = withBreaths(changed, changed.singers[0].id, [[9, 11]]);
  check('snapshot frozen name', snap.name, '排练前');
  check(
    'snapshot frozen parts',
    snap.parts.map((pt) => pt.name),
    ['测试声部'],
  );
  check(
    'snapshot frozen breaths',
    snap.singers.map((s) => s.breaths.map((b) => [b.start, b.end])),
    [[[1, 3]], [[5, 7]]],
  );
  check('snapshot projectName recorded', snap.projectName, 'relay-test');
  check('snapshot has no beatmap', (snap as unknown as Record<string, unknown>).beatMap, undefined);
}

// 28. 差异基本类型：新增 / 删除 / 移动（等时长平移）/ 时长变化（起点不变改终点）
{
  const p = relayProject([[], []], { minSingers: 1, bpm: 120 });
  const s0 = p.singers[0].id;
  const s1 = p.singers[1].id;
  const base: Project = {
    ...p,
    singers: p.singers.map((s) =>
      s.id === s0
        ? { ...s, breaths: [{ id: 'move', start: 2, end: 4 }, { id: 'keep', start: 8, end: 10 }] }
        : s.id === s1
          ? { ...s, breaths: [{ id: 'gone', start: 12, end: 14 }, { id: 'resize', start: 20, end: 22 }] }
          : s,
    ),
  };
  const snap = createSnapshot(base);
  let cur: Project = { ...base };
  // move：[2,4) → [5,7)（等时长）；gone 删除；resize [20,22) → [20,24)（仅时长）；新增 [30,32)
  cur = updateBreath(cur, s0, 'move', 5, 7);
  cur = {
    ...cur,
    singers: cur.singers.map((s) =>
      s.id === s1
        ? { ...s, breaths: s.breaths.filter((b) => b.id !== 'gone').map((b) => (b.id === 'resize' ? { ...b, end: 24 } : b)) }
        : s,
    ),
  };
  cur = {
    ...cur,
    singers: cur.singers.map((s) =>
      s.id === s0 ? { ...s, breaths: [...s.breaths, { id: 'added1', start: 30, end: 32 }] } : s,
    ),
  };
  const d = diffProjectSnapshot(cur, snap);
  check(
    'snapshot diff types',
    d.map((e) => [e.type, e.singerName, e.intervalId]),
    [
      ['moved', '歌手1', 'move'],
      ['removed', '歌手2', 'gone'],
      ['duration', '歌手2', 'resize'],
      ['added', '歌手1', 'added1'],
    ],
  );
  // 按时间升序：move@5 < removed@12 < duration@20 < added@30
  check(
    'snapshot diff sorted by time',
    d.map((e) => e.time),
    [5, 12, 20, 30],
  );
  const mv = d[0];
  check('snapshot moved flags', [mv.moved, mv.durationChanged], [true, false]);
  check('snapshot moved ranges', [mv.before, mv.after], [
    { start: 2, end: 4 },
    { start: 5, end: 7 },
  ]);
  const rz = d[2];
  check('snapshot duration flags', [rz.moved, rz.durationChanged], [false, true]);
  check('snapshot duration ranges', [rz.before, rz.after], [
    { start: 20, end: 22 },
    { start: 20, end: 24 },
  ]);
  check('snapshot kept interval omitted', d.some((e) => e.intervalId === 'keep'), false);
}

// 29. 半开区间语义：仅末尾时刻变化、时长不变不算差异；完全一致也不算
{
  const p = relayProject([[]], { minSingers: 1, bpm: 120 });
  const s0 = p.singers[0].id;
  const base: Project = { ...p, singers: [{ ...p.singers[0], breaths: [{ id: 'a', start: 2, end: 4 }] }] };
  const snap = createSnapshot(base);
  // 微小浮点抖动（< EPS）视为无差异
  const jitter = updateBreath(base, s0, 'a', 2 + 1e-9, 4 + 1e-9);
  check('snapshot jitter no diff', diffProjectSnapshot(jitter, snap), []);
  // [2,4) → [2,5)：起点不变，时长 +1
  const longer = updateBreath(base, s0, 'a', 2, 5);
  check('snapshot extend type', diffProjectSnapshot(longer, snap).map((e) => e.type), ['duration']);
  // [2,4) → [3,4)：终点不变、起点 +1，时长 -1 → moved（非 duration）
  const leftCut = updateBreath(base, s0, 'a', 3, 4);
  const d = diffProjectSnapshot(leftCut, snap);
  check('snapshot left-cut type', d.map((e) => [e.type, e.moved, e.durationChanged]), [['moved', true, true]]);
}

// 30. 对齐以歌手 ID 为准：歌手改名不产生新增 / 删除；ID 不同的歌手视为增删
{
  const p = relayProject([[[1, 2]]], { minSingers: 1, bpm: 120 });
  const s0 = p.singers[0].id;
  const snap = createSnapshot(p);
  const renamed: Project = {
    ...p,
    singers: p.singers.map((s) => (s.id === s0 ? { ...s, name: '新名字' } : s)),
  };
  const d = diffProjectSnapshot(renamed, snap);
  check('snapshot rename aligned by id', d, []);
  check('snapshot rename shows current name', diffStructure(renamed, snap).addedSingers, []);

  const replaced: Project = {
    ...p,
    singers: [{ id: 'other-id', name: '另一个人', partId: 'p1', breaths: [{ id: 'b2', start: 1, end: 2 }] }],
  };
  const d2 = diffProjectSnapshot(replaced, snap);
  check(
    'snapshot different singer id add/remove',
    d2.map((e) => [e.type, e.singerName, e.intervalId]),
    [
      ['removed', '歌手1', d2.find((x) => x.type === 'removed')!.intervalId],
      ['added', '另一个人', 'b2'],
    ],
  );
  check(
    'snapshot different singer structure',
    diffStructure(replaced, snap),
    { addedSingers: ['另一个人'], removedSingers: ['歌手1'], addedParts: [], removedParts: [] },
  );
}

// 31. 同时刻按歌手名排序：两位歌手同秒新增，名字序在前
{
  const p = relayProject([[], []], { minSingers: 1, bpm: 120 });
  const named: Project = {
    ...p,
    singers: p.singers.map((s, i) => ({ ...s, name: i === 0 ? '赵敏' : '安' })),
  };
  const snap = createSnapshot(named);
  const cur: Project = {
    ...named,
    singers: named.singers.map((s) => ({ ...s, breaths: [{ id: `b-${s.id}`, start: 10, end: 11 }] })),
  };
  check(
    'snapshot same-time name order',
    diffProjectSnapshot(cur, snap).map((e) => e.singerName),
    ['安', '赵敏'],
  );
}

// 32. 恢复快照：声部 / 歌手 / 区间回到快照；节拍图、曲名、全曲时长保持当前现状
{
  const p = relayProject([[[1, 2]]], { minSingers: 1, bpm: 120 });
  const snap = createSnapshot(p);
  const edited: Project = {
    ...p,
    name: '排练中的新曲名',
    duration: 40,
    beatMap: normalizeBeatMap({ startBpm: 60 }),
    singers: [{ id: 'newcomer', name: '新人', partId: 'p1', breaths: [{ id: 'x', start: 30, end: 32 }] }],
  };
  const restored = restoreProjectSnapshot(edited, snap);
  check('restore keeps current name', restored.name, '排练中的新曲名');
  check('restore keeps current duration', restored.duration, 40);
  check('restore keeps current beatmap', restored.beatMap.startBpm, 60);
  check(
    'restore replaces singers',
    restored.singers.map((s) => [s.id, s.breaths.map((b) => [b.start, b.end])]),
    p.singers.map((s) => [s.id, s.breaths.map((b) => [b.start, b.end])]),
  );
  // 恢复结果是深拷贝：再改恢复后的工程不影响快照
  restored.singers[0].breaths.push({ id: 'tamper', start: 0, end: 1 });
  check('restore is deep copy', snap.singers[0].breaths.some((b) => b.id === 'tamper'), false);
}

// 33. 声部增删的结构差异统计
{
  const p = createSampleProject();
  const snap = createSnapshot(p);
  const removedPartId = p.parts[0].id;
  const cur: Project = {
    ...p,
    parts: [...p.parts.slice(1), { id: 'newpart', name: '童声', color: '#fff', minSingers: 1 }],
    singers: p.singers.filter((s) => s.partId !== removedPartId),
  };
  const st = diffStructure(cur, snap);
  check('snapshot structure added parts', st.addedParts, ['童声']);
  check('snapshot structure removed parts', st.removedParts, [p.parts[0].name]);
  check('snapshot structure removed singers count', st.removedSingers.length, 3);
  check('snapshot structure added singers', st.addedSingers, []);
}

// 34. 默认快照名包含「排练快照」前缀
check('snapshot default name prefix', defaultSnapshotName(new Date('2026-09-21T10:05:00')).startsWith('排练快照 '), true);
{
  const p = relayProject([[]], { bpm: 120 });
  check('snapshot blank name falls back', createSnapshot(p, '   ').name.startsWith('排练快照 '), true);
  check('snapshot trims name', createSnapshot(p, '  周三联排  ').name, '周三联排');
}

// 35. 快照清洗：合法数据通过，非法声部 / 区间被丢弃或整体拒绝
{
  const p = relayProject([[[1, 2], [3, 3]]], { minSingers: 1, bpm: 120 });
  const snap = createSnapshot(p);
  const again = sanitizeSnapshot(JSON.parse(JSON.stringify(snap)));
  check('snapshot sanitize roundtrip ids', again?.id, snap.id);
  check('snapshot sanitize drops zero-length breath', again?.singers[0].breaths.length, 1);

  check('snapshot sanitize rejects junk', sanitizeSnapshot(null), null);
  check('snapshot sanitize rejects no parts', sanitizeSnapshot({ parts: [], singers: [] }), null);
  {
    // 声部合法但歌手引用了不存在的声部：歌手被过滤，快照仍合法（歌手数为 0）
    const orphan = sanitizeSnapshot({
      parts: [{ id: 'p1', name: 'P', color: '#000', minSingers: 1 }],
      singers: [{ id: 's1', name: 'S', partId: 'nope', breaths: [] }],
    });
    check('snapshot sanitize drops orphan singer', orphan?.singers.length, 0);
    check('snapshot sanitize keeps part', orphan?.parts.length, 1);
  }
}

// 36. 快照持久化：内存版 localStorage 存取（按创建时间倒序）
{
  const store = new Map<string, string>();
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
  const p = relayProject([[[1, 2]]], { bpm: 120 });
  const older = createSnapshot(p, '早', new Date('2026-09-01T09:00:00'));
  const newer = createSnapshot(p, '晚', new Date('2026-09-21T09:00:00'));
  saveSnapshots([older, newer]);
  const loaded = loadSnapshots();
  check('snapshots persist count', loaded.length, 2);
  check('snapshots newest first', loaded.map((s) => s.name), ['晚', '早']);
  // 损坏的存储数据不致命
  store.set('breath-relay:snapshots:v1', '{not json');
  check('snapshots corrupt storage safe', loadSnapshots(), []);
}

console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
