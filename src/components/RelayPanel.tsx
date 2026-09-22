import { useMemo, useState } from 'react';
import type { Project } from '../types';
import type { RelayRequest, RelayResult } from '../lib/relay';
import { beatToTime, timeToLocation } from '../lib/tempo';
import { fmtSec } from '../lib/format';

interface Props {
  project: Project;
  /** 搜索成功后的整组预览（null = 未搜索或搜索失败/已取消） */
  result: Extract<RelayResult, { ok: true }> | null;
  onPlan: (req: RelayRequest) => RelayResult;
  onApply: () => void;
  onCancel: () => void;
}

export default function RelayPanel(props: Props) {
  const { project } = props;
  const bpb = project.beatMap.beatsPerBar;
  const durationBeat = timeToLocation(project.duration, project.beatMap).absolute;

  const [partId, setPartId] = useState(project.parts[0]?.id ?? '');
  const [startBar, setStartBar] = useState(1);
  const [startBeat, setStartBeat] = useState(1);
  const [endBar, setEndBar] = useState(3);
  const [endBeat, setEndBeat] = useState(1);
  const [breathBeats, setBreathBeats] = useState(2);
  const [failure, setFailure] = useState<Extract<RelayResult, { ok: false }> | null>(null);

  const effectivePartId = project.parts.some((p) => p.id === partId) ? partId : project.parts[0]?.id ?? '';
  const part = project.parts.find((p) => p.id === effectivePartId) ?? null;
  const singerCount = project.singers.filter((s) => s.partId === effectivePartId).length;

  const absStart = (startBar - 1) * bpb + (startBeat - 1);
  const absEnd = (endBar - 1) * bpb + (endBeat - 1);

  const winStart = useMemo(() => beatToTime(absStart, project.beatMap), [absStart, project.beatMap]);
  const winEnd = useMemo(() => beatToTime(absEnd, project.beatMap), [absEnd, project.beatMap]);
  const windowBeats = absEnd - absStart;

  const formError = (() => {
    if (!part) return '工程中没有声部';
    if (singerCount === 0) return '该声部还没有歌手';
    if (absStart < 0 || startBeat < 1 || startBeat > bpb || endBeat < 1 || endBeat > bpb)
      return `拍号为每小节 ${bpb} 拍，小节内拍位须在 1–${bpb} 之间`;
    if (absEnd <= absStart) return '结束拍位必须晚于起始拍位';
    if (breathBeats < 1) return '每人换气拍数至少为 1';
    if (breathBeats > windowBeats) return `拍域只有 ${windowBeats} 拍，放不下 ${breathBeats} 拍的换气`;
    if (winEnd > project.duration + 1e-6) return `结束拍位（${fmtSec(winEnd)}）超出全曲时长 ${fmtSec(project.duration)}`;
    return null;
  })();

  const run = () => {
    if (formError) return;
    const r = props.onPlan({ partId: effectivePartId, startBeat: absStart, endBeat: absEnd, breathBeats });
    setFailure(r.ok ? null : r);
  };

  const preview = props.result;
  const previewPart = preview ? project.parts.find((p) => p.id === preview.partId) : null;

  return (
    <section className="optimizer relay-panel">
      <h3>🔗 声部接力排程（整组回溯搜索）</h3>
      <div className="relay-form">
        <label className="relay-field">
          <span>声部</span>
          <select value={effectivePartId} onChange={(e) => setPartId(e.target.value)}>
            {project.parts.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}（{project.singers.filter((s) => s.partId === p.id).length} 人 · 需≥{p.minSingers}）
              </option>
            ))}
          </select>
        </label>
        <div className="relay-field">
          <span>起始拍位</span>
          <input
            type="number"
            min={1}
            value={startBar}
            onChange={(e) => setStartBar(Math.max(1, Math.round(Number(e.target.value)) || 1))}
          />
          <em className="relay-sep">小节</em>
          <input
            type="number"
            min={1}
            max={bpb}
            value={startBeat}
            onChange={(e) => setStartBeat(Math.min(bpb, Math.max(1, Math.round(Number(e.target.value)) || 1)))}
          />
          <em className="relay-sep">拍</em>
        </div>
        <div className="relay-field">
          <span>结束拍位</span>
          <input
            type="number"
            min={1}
            value={endBar}
            onChange={(e) => setEndBar(Math.max(1, Math.round(Number(e.target.value)) || 1))}
          />
          <em className="relay-sep">小节</em>
          <input
            type="number"
            min={1}
            max={bpb}
            value={endBeat}
            onChange={(e) => setEndBeat(Math.min(bpb, Math.max(1, Math.round(Number(e.target.value)) || 1)))}
          />
          <em className="relay-sep">拍（不含）</em>
        </div>
        <label className="relay-field">
          <span>每人换气</span>
          <input
            type="number"
            min={1}
            value={breathBeats}
            onChange={(e) => setBreathBeats(Math.max(1, Math.round(Number(e.target.value)) || 1))}
          />
          <em className="relay-sep">拍</em>
        </label>
        <button className="primary" onClick={run} disabled={!!formError}>
          回溯搜索
        </button>
      </div>

      <p className="hint">
        拍域：第 {startBar}:{startBeat} – 第 {endBar}:{endBeat}（不含），共 {Math.max(0, windowBeats)} 拍 ≈{' '}
        {fmtSec(winStart)} – {fmtSec(winEnd)}
        {part ? `；全曲 ${fmtSec(project.duration)} ≈ ${Math.round(durationBeat)} 拍` : ''}
        。跨变速点时按拍位枚举、再换算为秒。
      </p>
      {formError && <p className="relay-error bad">⚠ {formError}</p>}
      {failure && (
        <p className={`relay-error ${failure.reason === 'no-slot' ? 'relay-warn' : 'bad'}`}>
          {failure.reason === 'no-slot' ? '🧍 歌手无可用拍位：' : '🛡 覆盖门槛冲突：'}
          {failure.message.replace(/^.*?：/, '')}
        </p>
      )}

      {preview && previewPart && (
        <div className="opt-result">
          <div className="diff">
            <span>
              已为 <b>{previewPart.name}</b> 的 {preview.assignments.length} 位歌手各安排 {preview.assignments[0].breathBeats}{' '}
              拍换气
            </span>
            <span className="badge ok">可行解</span>
          </div>
          <ul className="relay-list">
            {preview.assignments.map((a) => {
              const s = project.singers.find((x) => x.id === a.singerId);
              return (
                <li key={a.singerId}>
                  <b>{s?.name ?? '?'}</b>
                  <span className="muted">
                    第 {beatLabel(a.startBeat, bpb)} 起 · 拍 {a.startBeat}–{a.startBeat + a.breathBeats} ·{' '}
                    {fmtSec(a.start)} – {fmtSec(a.end)}
                  </span>
                </li>
              );
            })}
          </ul>
          <div className="stats">虚线幽灵块为整组预览结果；确认后一次写入，取消不改动工程。</div>
          <div className="opt-actions">
            <button className="primary" onClick={props.onApply}>
              整组写入
            </button>
            <button onClick={props.onCancel}>取消</button>
          </div>
        </div>
      )}

    </section>
  );
}

function beatLabel(absBeat: number, bpb: number): string {
  return `${Math.floor(absBeat / bpb) + 1}:${(absBeat % bpb) + 1}`;
}
