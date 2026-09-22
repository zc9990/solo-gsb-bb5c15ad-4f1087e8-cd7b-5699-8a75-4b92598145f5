import type { FatigueSettings, Project, RehearsalSnapshot } from '../types';
import { totalSeconds, type UnderSegment } from '../lib/coverage';
import { DISABLED_FATIGUE, fatigueEnabled, fatigueSummary, type FatigueSegment } from '../lib/fatigue';
import { MIN_DURATION, clamp } from '../lib/constraints';
import { fmtSec } from '../lib/format';
import { uid } from '../lib/id';
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
  /** 各歌手持续发声疲劳警示时段（预览时基于预览工程实时重算） */
  fatigue: Map<string, FatigueSegment[]>;
  /** 以不可变方式修改工程（会自动使寻优结果失效） */
  mutate: (fn: (p: Project) => Project) => void;
  /** 修改节拍图（不影响换气段的秒位置，也不使寻优结果失效） */
  mutateBeatMap: (fn: (b: Project['beatMap']) => Project['beatMap']) => void;
  snapshots: RehearsalSnapshot[];
  onCreateSnapshot: (name: string) => void;
  onRestoreSnapshot: (snapshot: RehearsalSnapshot) => void;
  onDeleteSnapshot: (snapshotId: string) => void;
  /** 点击疲劳汇总条目：把时间轴滚动到对应歌手的对应时刻 */
  onJumpToTime: (singerId: string, t: number) => void;
}

const PALETTE = ['#f472b6', '#a78bfa', '#60a5fa', '#34d399', '#fbbf24', '#f87171', '#22d3ee', '#c084fc'];

export default function Sidebar({
  project,
  coverage,
  fatigue,
  mutate,
  mutateBeatMap,
  snapshots,
  onCreateSnapshot,
  onRestoreSnapshot,
  onDeleteSnapshot,
  onJumpToTime,
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
        singers: [
          ...p.singers,
          { id: uid(), name: `歌手${count + 1}`, partId, breaths: [], fatigue: { ...DISABLED_FATIGUE } },
        ],
      };
    });

  const removeSinger = (singerId: string) =>
    mutate((p) => ({ ...p, singers: p.singers.filter((s) => s.id !== singerId) }));

  const renameSinger = (singerId: string, name: string) =>
    mutate((p) => ({ ...p, singers: p.singers.map((s) => (s.id === singerId ? { ...s, name } : s)) }));

  /** 修改疲劳设置：负数或非有限值（NaN / Infinity）直接忽略，不进入状态。 */
  const setFatigue = (singerId: string, field: keyof FatigueSettings, raw: string) => {
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return;
    mutate((p) => ({
      ...p,
      singers: p.singers.map((s) =>
        s.id !== singerId ? s : { ...s, fatigue: { ...s.fatigue, [field]: n } },
      ),
    }));
  };

  // 疲劳警示汇总：按开始时间升序，可点击跳转到时间轴
  const fatigueEntries = fatigueSummary(project, fatigue);

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
                  const warnCount = (fatigue.get(s.id) ?? []).length;
                  return (
                    <li key={s.id} className="singer-item">
                      <div className="singer-line">
                        <input value={s.name} onChange={(e) => renameSinger(s.id, e.target.value)} />
                        <span className="breath-count">{s.breaths.length} 段</span>
                        {fatigueEnabled(s) && warnCount > 0 && (
                          <span className="fatigue-flag" title={`${warnCount} 段持续发声超限`}>
                            ⚠{warnCount}
                          </span>
                        )}
                        <button className="icon-btn" title="删除歌手" onClick={() => removeSinger(s.id)}>
                          ✕
                        </button>
                      </div>
                      <div
                        className="fatigue-edit"
                        title="持续发声疲劳检查：连续发声超过上限即在歌手轨道标记警示；只有时长达到恢复阈值的换气才清零累计，较短换气只暂停。任一项为 0 表示停用。"
                      >
                        <label>
                          连续≤
                          <input
                            type="number"
                            min={0}
                            step={0.5}
                            value={s.fatigue.maxSingSeconds}
                            onChange={(e) => setFatigue(s.id, 'maxSingSeconds', e.target.value)}
                          />
                          秒
                        </label>
                        <label>
                          恢复≥
                          <input
                            type="number"
                            min={0}
                            step={0.5}
                            value={s.fatigue.recoveryBreathSeconds}
                            onChange={(e) => setFatigue(s.id, 'recoveryBreathSeconds', e.target.value)}
                          />
                          秒
                        </label>
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
        <h3>🔥 疲劳警示汇总</h3>
        {fatigueEntries.length === 0 ? (
          <p className="hint">暂无持续发声超限时段。在歌手名下设置「连续≤ / 恢复≥」秒数即可启用检查（0 = 停用）。</p>
        ) : (
          <ul className="fatigue-list">
            {fatigueEntries.map((e) => (
              <li key={`${e.singerId}-${e.start}-${e.end}`}>
                <button
                  className="fatigue-jump"
                  title={`跳转到 ${e.singerName} ${fmtSec(e.start)} 处\n峰值连续发声 ${fmtSec(e.peakSeconds)}`}
                  onClick={() => onJumpToTime(e.singerId, e.start)}
                >
                  <span className="fatigue-time">{fmtSec(e.start)}</span>
                  <span className="dot" style={{ background: e.partColor }} />
                  <span className="fatigue-name">{e.singerName}</span>
                  <span className="muted">
                    {fmtSec(e.start)} – {fmtSec(e.end)}
                  </span>
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
          <li>排练前在「排练快照」保存当前规划；展开快照可查看按时间排序的区间增删 / 移动 / 时长差异，二次确认后恢复（节拍图不受影响）</li>
          <li>在歌手名下设置「连续≤ / 恢复≥」秒数启用持续发声疲劳检查（0 = 停用）；超限时段在歌手轨道以橙色警示层标出，侧栏汇总可点击跳转</li>
          <li>Delete / Backspace：删除选中的换气段</li>
        </ul>
      </section>
    </aside>
  );
}
