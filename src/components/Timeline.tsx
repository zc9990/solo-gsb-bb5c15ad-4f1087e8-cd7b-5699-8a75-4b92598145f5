import { useMemo, useState } from 'react';
import type { Project, Selection } from '../types';
import { totalSeconds, type Segment, type UnderSegment } from '../lib/coverage';
import { placeNewInterval, placeNewIntervalOnBeat } from '../lib/constraints';
import { beatTicks, fmtTimeAsBeat, snapTimeToBeat, timeToLocation } from '../lib/tempo';
import { fmtSec, fmtTick } from '../lib/format';
import BreathBlock from './BreathBlock';

export interface Ghost {
  singerId: string;
  start: number;
  end: number;
}

/** 接力排程预览：整组幽灵块 + 拍域窗口（秒） */
export interface RelayPreview {
  partId: string;
  windowStart: number;
  windowEnd: number;
  ghosts: Ghost[];
}

type RulerMode = 'seconds' | 'beats';

interface Props {
  project: Project;
  /** 各声部未达标时段（预览时基于预览工程计算） */
  coverage: Map<string, UnderSegment[]>;
  selection: Selection | null;
  ghost: Ghost | null;
  /** 声部接力排程的整组幽灵块预览（null = 未在预览） */
  relayPreview: RelayPreview | null;
  pxPerSec: number;
  onSelect: (sel: Selection | null) => void;
  onUpdateInterval: (singerId: string, intervalId: string, start: number, end: number) => void;
  onAddInterval: (singerId: string, seg: Segment) => void;
}

export default function Timeline(props: Props) {
  const { project, pxPerSec } = props;
  const [rulerMode, setRulerMode] = useState<RulerMode>('seconds');
  const [beatSnap, setBeatSnap] = useState(false);
  const beatMode = rulerMode === 'beats';

  const width = project.duration * pxPerSec;
  const secTicks: number[] = [];
  for (let t = 0; t <= project.duration; t++) secTicks.push(t);
  const bTicks = useMemo(
    () => beatTicks(project.beatMap, project.duration),
    [project.beatMap, project.duration],
  );

  const beatMap = project.beatMap;
  const snapFn = useMemo(
    () => (beatSnap ? (t: number) => snapTimeToBeat(t, beatMap) : undefined),
    [beatSnap, beatMap],
  );

  // 拍很密时小节线（强拍）每根都画，普通拍线抽样渲染，避免 DOM 过多
  const beatDense = bTicks.length > 1200;
  const gridStyle = beatMode
    ? { width, backgroundColor: 'rgba(56,189,248,0.03)' }
    : {
        width,
        backgroundImage: 'linear-gradient(to right, rgba(148,163,184,.10) 1px, transparent 1px)',
        backgroundSize: `${5 * pxPerSec}px 100%`,
      };

  /** 节拍标尺下叠加在轨道上的小节线 / 拍线 */
  const beatGrid = (
    <>
      {bTicks.map((tk) => {
        if (!beatDense && !tk.downbeat) {
          return (
            <div
              key={`g${tk.beat}`}
              className="beat-grid-line minor"
              style={{ left: tk.time * pxPerSec }}
            />
          );
        }
        if (tk.downbeat) {
          return (
            <div
              key={`g${tk.beat}`}
              className="beat-grid-line major"
              style={{ left: tk.time * pxPerSec }}
            />
          );
        }
        return null;
      })}
    </>
  );

  /** 换气段在节拍标尺下的标签：整拍时长显示「N拍」，否则显示秒 */
  const blockBeatLabel = (b: Segment): string | null => {
    if (!beatMode) return null;
    const sb = timeToLocation(b.start, beatMap).absolute;
    const eb = timeToLocation(b.end, beatMap).absolute;
    const n = Math.round(eb - sb);
    if (Math.abs(eb - sb - n) < 1e-6 && n >= 1) return `${n}拍`;
    return fmtSec(b.end - b.start);
  };

  return (
    <div className="timeline" onClick={() => props.onSelect(null)}>
      <div className="trow ruler-row">
        <div className="trow-label ruler-controls" onClick={(e) => e.stopPropagation()}>
          <div className="seg-toggle">
            <button
              className={!beatMode ? 'active' : ''}
              title="按秒显示标尺"
              onClick={() => setRulerMode('seconds')}
            >
              秒
            </button>
            <button
              className={beatMode ? 'active' : ''}
              title="按小节/拍显示标尺"
              onClick={() => setRulerMode('beats')}
            >
              拍
            </button>
          </div>
          <label className="snap-toggle" title="开启后新增或拖拽换气段会吸附到整拍（跨变速点同样落在正确拍位）">
            <input type="checkbox" checked={beatSnap} onChange={(e) => setBeatSnap(e.target.checked)} />
            按拍吸附
          </label>
        </div>
        <div className="track ruler" style={{ width }}>
          {!beatMode
            ? secTicks.map((t) => (
                <div
                  key={t}
                  className={t % 5 === 0 ? 'tick major' : 'tick minor'}
                  style={{ left: t * pxPerSec }}
                >
                  {t % 5 === 0 && <span>{fmtTick(t)}</span>}
                </div>
              ))
            : bTicks.map((tk) =>
                tk.downbeat ? (
                  <div key={tk.beat} className="tick beat-major" style={{ left: tk.time * pxPerSec }}>
                    <span>{tk.measure}</span>
                    {tk.beat > 0 && (
                      <em className="tempo-flag" title={`第 ${tk.measure} 小节起 ${tk.bpm} BPM`}>
                        ♩={tk.bpm}
                      </em>
                    )}
                  </div>
                ) : (
                  !beatDense && (
                    <div key={tk.beat} className="tick beat-minor" style={{ left: tk.time * pxPerSec }} />
                  )
                ),
              )}
          <em className="ruler-unit">{beatMode ? '小节' : '秒'}</em>
        </div>
      </div>

      {project.parts.map((part) => {
        const singers = project.singers.filter((s) => s.partId === part.id);
        const under = props.coverage.get(part.id) ?? [];
        const underSec = totalSeconds(under);
        const relayWin =
          props.relayPreview && props.relayPreview.partId === part.id
            ? props.relayPreview
            : null;
        return (
          <div className="part-block" key={part.id}>
            <div className="trow coverage-row">
              <div className="trow-label">
                <span className="dot" style={{ background: part.color }} />
                <span className="part-title">{part.name}</span>
                <span className="part-req">需≥{part.minSingers}人</span>
                <em className={underSec > 0 ? 'bad' : 'ok'}>
                  {underSec > 0 ? `未达标 ${underSec.toFixed(1)}s` : '达标'}
                </em>
              </div>
              <div className="track coverage-track" style={gridStyle}>
                {beatMode && beatGrid}
                {relayWin && (
                  <div
                    className="relay-window"
                    style={{
                      left: relayWin.windowStart * pxPerSec,
                      width: (relayWin.windowEnd - relayWin.windowStart) * pxPerSec,
                    }}
                  />
                )}
                {under.map((seg) => (
                  <div
                    key={`${seg.start}-${seg.end}`}
                    className="under-seg"
                    style={{ left: seg.start * pxPerSec, width: Math.max(2, (seg.end - seg.start) * pxPerSec) }}
                    title={
                      beatMode
                        ? `拍位 ${fmtTimeAsBeat(seg.start, beatMap)} – ${fmtTimeAsBeat(seg.end, beatMap)}\n人数不足 ${fmtSec(seg.start)} – ${fmtSec(seg.end)}\n最少 ${seg.minSinging} 人发声（缺 ${seg.deficit} 人）`
                        : `人数不足 ${fmtSec(seg.start)} – ${fmtSec(seg.end)}\n最少 ${seg.minSinging} 人发声（缺 ${seg.deficit} 人）`
                    }
                  />
                ))}
              </div>
            </div>

            {singers.length === 0 && (
              <div className="trow empty-row">
                <div className="trow-label" />
                <div className="track empty-track" style={{ width }}>
                  该声部暂无歌手，请在左侧添加
                </div>
              </div>
            )}

            {singers.map((singer) => {
              const relayGhosts = props.relayPreview
                ? props.relayPreview.ghosts.filter((g) => g.singerId === singer.id)
                : [];
              return (
                <div className="trow singer-row" key={singer.id}>
                  <div className="trow-label">{singer.name}</div>
                  <div
                    className="track singer-track"
                    style={gridStyle}
                    onDoubleClick={(e) => {
                      const rect = e.currentTarget.getBoundingClientRect();
                      const t = (e.clientX - rect.left) / pxPerSec;
                      const seg = beatSnap
                        ? placeNewIntervalOnBeat(t, singer.breaths, project.duration, beatMap)
                        : placeNewInterval(t, singer.breaths, project.duration);
                      if (seg) props.onAddInterval(singer.id, seg);
                    }}
                  >
                    {beatMode && beatGrid}
                    {relayWin && (
                      <div
                        className="relay-window singer"
                        style={{
                          left: relayWin.windowStart * pxPerSec,
                          width: (relayWin.windowEnd - relayWin.windowStart) * pxPerSec,
                        }}
                      />
                    )}
                  {singer.breaths.map((b) => (
                    <BreathBlock
                      key={b.id}
                      interval={b}
                      others={singer.breaths.filter((o) => o.id !== b.id)}
                      songDuration={project.duration}
                      pxPerSec={pxPerSec}
                      color={part.color}
                      selected={props.selection?.intervalId === b.id}
                      dimmed={props.ghost !== null && props.selection?.intervalId === b.id}
                      snapFn={snapFn}
                      beatLabel={blockBeatLabel(b)}
                      beatTitle={
                        beatMode
                          ? `拍位 ${fmtTimeAsBeat(b.start, beatMap)} – ${fmtTimeAsBeat(b.end, beatMap)}`
                          : null
                      }
                      onSelect={() => props.onSelect({ singerId: singer.id, intervalId: b.id })}
                      onChange={(s, en) => props.onUpdateInterval(singer.id, b.id, s, en)}
                    />
                  ))}
                  {props.ghost && props.ghost.singerId === singer.id && (
                    <div
                      className="breath-ghost"
                      style={{
                        left: props.ghost.start * pxPerSec,
                        width: Math.max(4, (props.ghost.end - props.ghost.start) * pxPerSec),
                        borderColor: part.color,
                      }}
                    />
                  )}
                  {relayGhosts.map((g) => (
                    <div
                      key={`relay-${g.start}-${g.end}`}
                      className="breath-ghost relay"
                      style={{
                        left: g.start * pxPerSec,
                        width: Math.max(4, (g.end - g.start) * pxPerSec),
                        borderColor: part.color,
                      }}
                      title={`接力换气（预览）${fmtSec(g.start)} – ${fmtSec(g.end)}`}
                    />
                  ))}
                </div>
              </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
