import type { Project, RehearsalSnapshot } from '../types';
import { totalSeconds, type UnderSegment } from '../lib/coverage';
import type { FatigueAlert } from '../lib/fatigue';
import { fatigueDomId } from '../lib/fatigue';
import { MIN_DURATION, clamp } from '../lib/constraints';
import { uid } from '../lib/id';
import { fmtSec } from '../lib/format';
import {
  nextFreeMeasure,
  removeTempoChange,
  setTempoChange,
  timeToLocation,
  updateBeatMap,
} from '../lib/tempo';
import SnapshotPanel from './SnapshotPanel';

interface Props {
  project: Project;
  coverage: Map<string, UnderSegment[]>;
  /** 持续发声疲劳警示（已按开始时间排序；预览时基于预览工程实时重算） */
  fatigueAlerts: FatigueAlert[];
  /** 以不可变方式修改工程（会自动使寻优结果失效） */
  mutate: (fn: (p: Project) => Project) => void;
  /** 修改节拍图（不影响换气段的秒位置，也不使寻优结果失效） */
  mutateBeatMap: (fn: (b: Project['beatMap']) => Project['beatMap']) => void;
  /** 跳转到时间轴上对应的疲劳警示（横向滚到时刻、纵向滚到歌手行） */
  onJumpFatigue: (singerId: string, index: number) => void;
  snapshots: RehearsalSnapshot[];
  onCreateSnapshot: (name: string) => void;
  onRestoreSnapshot: (snapshot: RehearsalSnapshot) => void;
  onDeleteSnapshot: (snapshotId: string) => void;
}

const PALETTE = ['#f472b6', '#a78bfa', '#60a5fa', '#34d399', '#fbbf24', '#f87171', '#22d3ee', '#c084fc'];

export default function Sidebar({
  project,
  coverage,
  fatigueAlerts,
  mutate,
  mutateBeatMap,
  onJumpFatigue,
  snapshots,
  onCreateSnapshot,
  onRestoreSnapshot,
  onDeleteSnapshot,
}: Props) {
  const beatMap = project.beatMap;

  // ---------- 节拍图 ----------
  const setBeatsPerBar = (raw: string) => {
    const n = Math.round(Number(raw));
    if (!Number.isFinite(n) || n < 1 || n > 16) return;
    mutateBeatMap((b) => updateBeatMap(b, { beatsPerBar: n }));
  };

  const setBeatUnit = (raw: string) => {
    const n = Math.round(Number(raw));
    if (!Number.isFinite(n) || n < 1 || n > 16) return;
    mutateBeatMap((b) => updateBeatMap(b, { beatUnit: n }));
  };

  const setStartBpm = (raw: string) => {
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 1 || n > 999) return;
    mutateBeatMap((b) => updateBeatMap(b, { startBpm: n }));
  };

  const addChange = () => {
    const measure = nextFreeMeasure(beatMap);
    const next = setTempoChange(beatMap, measure, beatMap.startBpm);
    if (next) mutateBeatMap(() => next);
  };

  const editChange = (id: string, patch: { measure?: number; bpm?: number }) => {
    const cur = beatMap.changes.find((c) => c.id === id);
    if (!cur) return;
    const measure = patch.measure !== undefined ? Math.round(patch.measure) : cur.measure;
    const bpm = patch.bpm !== undefined ? Number(patch.bpm) : cur.bpm;
    if (!Number.isFinite(measure) || measure < 2) return;
    if (!Number.isFinite(bpm) || bpm < 1 || bpm > 999) return;
    const next = setTempoChange(beatMap, measure, bpm, id);
    if (!next) {
      alert('该小节首拍已有变速点');
      return;
    }
    mutateBeatMap(() => next);
  };

  // 全曲时长落在第几小节第几拍（只显示，不改变秒位置）
  const endLoc = timeToLocation(project.duration, beatMap);
  const endBeatText = `${endLoc.measure}:${Math.round(endLoc.beatInBar * 100) / 100}`;

  const setDuration = (raw: string) => {
    const d = Math.round(Number(raw));
    if (!Number.isFinite(d) || d < 10 || d > 3600) return;
    mutate((p) => ({
      ...p,
      duration: d,
      singers: p.singers.map((s) => ({
        ...s,
        breaths: s.breaths
          .map((b) => ({ ...b, start: clamp(b.start, 0, d), end: clamp(b.end, 0, d) }))
          .filter((b) => b.end - b.start >= MIN_DURATION),
      })),
    }));
  };

  const addPart = () =>
    mutate((p) => ({
      ...p,
      parts: [
        ...p.parts,
        {
          id: uid(),
          name: `声部${p.parts.length + 1}`,
          color: PALETTE[p.parts.length % PALETTE.length],
          minSingers: 1,
        },
      ],
    }));

  const removePart = (partId: string) =>
    mutate((p) => ({
      ...p,
      parts: p.parts.filter((x) => x.id !== partId),
      singers: p.singers.filter((s) => s.partId !== partId),
    }));

  const renamePart = (partId: string, name: string) =>
    mutate((p) => ({ ...p, parts: p.parts.map((x) => (x.id === partId ? { ...x, name } : x)) }));

  const setMinSingers = (partId: string, raw: string) => {
    const n = Math.round(Number(raw));
    if (!Number.isFinite(n) || n < 0 || n > 99) return;
    mutate((p) => ({ ...p, parts: p.parts.map((x) => (x.id === partId ? { ...x, minSingers: n } : x)) }));
  };

  const addSinger = (partId: string) =>
    mutate((p) => {
      const count = p.singers.filter((s) => s.partId === partId).length;
      return {
        ...p,
        // 新歌手默认停用疲劳检查（两项均为 0）
        singers: [...p.singers, { id: uid(), name: `歌手${count + 1}`, partId, maxSustainSec: 0, recoveryBreathSec: 0, breaths: [] }],
      };
    });

  const removeSinger = (singerId: string) =>
    mutate((p) => ({ ...p, singers: p.singers.filter((s) => s.id !== singerId) }));

  const renameSinger = (singerId: string, name: string) =>
    mutate((p) => ({ ...p, singers: p.singers.map((s) => (s.id === singerId ? { ...s, name } : s)) }));

  /**
   * 修改歌手疲劳设置：输入框清空 / 负数 / 非有限值一律按 0（停用）处理，
   * 合法非负值吸附到 0.1 秒——非法值不会进入工程状态。
   */
  const setSingerLimit = (singerId: string, key: 'maxSustainSec' | 'recoveryBreathSec', raw: string) => {
    const n = Number(raw);
    if (raw.trim() === '' || !Number.isFinite(n) || n < 0) {
      mutate((p) => ({ ...p, singers: p.singers.map((s) => (s.id === singerId ? { ...s, [key]: 0 } : s)) }));
      return;
    }
    const v = Math.min(36000, Math.round(n * 10) / 10);
    mutate((p) => ({ ...p, singers: p.singers.map((s) => (s.id === singerId ? { ...s, [key]: v } : s)) }));
  };

  return (
    <aside className="sidebar">
      <section className="side-section">
        <h3>🎼 歌曲</h3>
        <label className="field">
          <span>曲名</span>
          <input value={project.name} onChange={(e) => mutate((p) => ({ ...p, name: e.target.value }))} />
        </label>
        <label className="field">
          <span>时长（秒）</span>
          <input
            type="number"
            min={10}
            max={3600}
            value={project.duration}
            onChange={(e) => setDuration(e.target.value)}
          />
        </label>
      </section>

      <section className="side-section beatmap-section">
        <h3>🎚 节拍图（分段恒速）</h3>
        <div className="beatmap-row">
          <label className="field">
            <span>拍号</span>
            <input
              type="number"
              min={1}
              max={16}
              value={beatMap.beatsPerBar}
              onChange={(e) => setBeatsPerBar(e.target.value)}
            />
          </label>
          <span className="time-slash">/</span>
          <label className="field unit-field">
            <input
              type="number"
              min={1}
              max={16}
              value={beatMap.beatUnit}
              onChange={(e) => setBeatUnit(e.target.value)}
            />
          </label>
        </div>
        <label className="field">
          <span>起始 BPM</span>
          <input
            type="number"
            min={1}
            max={999}
            step={0.1}
            value={beatMap.startBpm}
            onChange={(e) => setStartBpm(e.target.value)}
          />
        </label>

        <div className="tempo-changes">
          {beatMap.changes.length === 0 && <p className="hint">暂无变速点，全曲按起始 BPM 恒速。</p>}
          {beatMap.changes.map((c) => (
            <div className="tempo-row" key={c.id}>
              <span className="muted">第</span>
              <input
                type="number"
                min={2}
                max={100000}
                value={c.measure}
                onChange={(e) => editChange(c.id, { measure: Number(e.target.value) })}
              />
              <span className="muted">小节首拍起</span>
              <input
                type="number"
                min={1}
                max={999}
                step={0.1}
                value={c.bpm}
                onChange={(e) => editChange(c.id, { bpm: Number(e.target.value) })}
              />
              <span className="muted">BPM</span>
              <button className="icon-btn" title="删除变速点" onClick={() => mutateBeatMap((b) => removeTempoChange(b, c.id))}>
                ✕
              </button>
            </div>
          ))}
        </div>
        <button className="ghost-btn" onClick={addChange}>
          ＋ 添加变速点
        </button>
        <p className="beatmap-end muted">
          当前时长 {project.duration}s ≈ 第 {endBeatText} 拍（编辑节拍图只改拍位显示，不移动换气段）
        </p>
      </section>

      <section className="side-section">
        <h3>🎤 声部与歌手</h3>
        {project.parts.map((part) => {
          const singers = project.singers.filter((s) => s.partId === part.id);
          const underSec = totalSeconds(coverage.get(part.id) ?? []);
          return (
            <div className="part-card" key={part.id}>
              <div className="part-head">
                <span className="dot" style={{ background: part.color }} />
                <input className="part-name" value={part.name} onChange={(e) => renamePart(part.id, e.target.value)} />
                <button className="icon-btn" title="删除该声部及其歌手" onClick={() => removePart(part.id)}>
                  ✕
                </button>
              </div>
              <div className="part-meta">
                <label>
                  最低发声
                  <input
                    type="number"
                    min={0}
                    max={99}
                    value={part.minSingers}
                    onChange={(e) => setMinSingers(part.id, e.target.value)}
                  />
                  人
                </label>
                <span className={underSec > 0 ? 'bad' : 'ok'}>
                  {underSec > 0 ? `未达标 ${underSec.toFixed(1)}s` : '全曲达标'}
                </span>
              </div>
              <ul className="singer-list">
                {singers.map((s) => {
                  const fatigueCount = fatigueAlerts.filter((a) => a.singerId === s.id).length;
                  return (
                    <li className="singer-item" key={s.id}>
                      <div className="singer-row1">
                        <input value={s.name} onChange={(e) => renameSinger(s.id, e.target.value)} />
                        {fatigueCount > 0 && (
                          <span className="fatigue-badge" title={`${fatigueCount} 段持续发声疲劳警示`}>
                            ⚠{fatigueCount}
                          </span>
                        )}
                        <button className="icon-btn" title="删除歌手" onClick={() => removeSinger(s.id)}>
                          ✕
                        </button>
                      </div>
                      <div className="singer-limits" title="0 表示停用；仅时长达到恢复秒数的换气才清零累计，较短换气只暂停">
                        <label>
                          最长发声
                          <input
                            type="number"
                            min={0}
                            max={36000}
                            step={0.5}
                            value={s.maxSustainSec}
                            onChange={(e) => setSingerLimit(s.id, 'maxSustainSec', e.target.value)}
                          />
                          s
                        </label>
                        <label>
                          恢复换气
                          <input
                            type="number"
                            min={0}
                            max={36000}
                            step={0.5}
                            value={s.recoveryBreathSec}
                            onChange={(e) => setSingerLimit(s.id, 'recoveryBreathSec', e.target.value)}
                          />
                          s
                        </label>
                        <span className="breath-count">{s.breaths.length} 段</span>
                      </div>
                    </li>
                  );
                })}
              </ul>
              <button className="ghost-btn" onClick={() => addSinger(part.id)}>
                ＋ 添加歌手
              </button>
            </div>
          );
        })}
        <button className="ghost-btn wide" onClick={addPart}>
          ＋ 添加声部
        </button>
      </section>

      <section className="side-section fatigue-section">
        <h3>
          😮‍💨 持续发声疲劳
          {fatigueAlerts.length > 0 && <span className="fatigue-total">⚠ {fatigueAlerts.length} 处</span>}
        </h3>
        <p className="hint">
          为每位歌手设置「最长连续发声」与「有效恢复换气」秒数（0 停用）；只有达到恢复时长的换气才清零累计，
          短换气只暂停。越界时段在歌手轨道以橙色警示层标出，按开始时间排序、点击可跳转。
        </p>
        {fatigueAlerts.length === 0 ? (
          <p className="hint">当前没有持续发声疲劳警示。</p>
        ) : (
          <ul className="fatigue-list">
            {fatigueAlerts.map((a, i) => (
              <li key={`${fatigueDomId(a.singerId, i)}`}>
                <button
                  className="fatigue-entry"
                  title={`跳转到 ${a.name} 的疲劳时段 ${fmtSec(a.start)} – ${fmtSec(a.end)}`}
                  onClick={() => onJumpFatigue(a.singerId, i)}
                >
                  <span className="fatigue-time">
                    {fmtSec(a.start)} – {fmtSec(a.end)}
                  </span>
                  <span className="fatigue-who">
                    {a.partName} · {a.name}
                  </span>
                  <span className="fatigue-peak muted">连续 {a.peakSinging.toFixed(1)}s / 上限 {a.maxSustainSec}s</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <SnapshotPanel
        project={project}
        snapshots={snapshots}
        onCreate={onCreateSnapshot}
        onRestore={onRestoreSnapshot}
        onDelete={onDeleteSnapshot}
      />

      <section className="side-section tips">
        <h3>💡 操作提示</h3>
        <ul>
          <li>双击歌手轨道空白处：新增换气段</li>
          <li>拖动换气段：整体移动；拖动两端：调整时长</li>
          <li>时间轴可在「秒 / 拍」标尺间切换，勾选「按拍吸附」后新增与拖拽自动落到整拍</li>
          <li>点击换气段选中后，可在右下方面板一键寻优</li>
          <li>在下方「声部接力排程」选择声部、起止拍位与每人换气拍数，可回溯搜索整组接力换气，幽灵块预览后再整组写入</li>
          <li>为歌手设置最长连续发声与恢复换气秒数后，橙色警示层标出越界时段；侧栏汇总按时间排序、点击跳转（拖拽 / 预览实时重算）</li>
          <li>排练前在「排练快照」保存当前规划；展开快照可查看按时间排序的区间增删 / 移动 / 时长差异，二次确认后恢复（节拍图不受影响）</li>
          <li>Delete / Backspace：删除选中的换气段</li>
        </ul>
      </section>
    </aside>
  );
}
