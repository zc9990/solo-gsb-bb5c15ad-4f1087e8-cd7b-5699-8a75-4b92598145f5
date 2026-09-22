import { useEffect, useMemo, useState } from 'react';
import type { Project, RehearsalSnapshot } from '../types';
import { diffProjectSnapshot, diffStructure, type SnapshotDiffEntry } from '../lib/snapshot';
import { fmtOffset, fmtSec } from '../lib/format';

interface Props {
  project: Project;
  snapshots: RehearsalSnapshot[];
  onCreate: (name: string) => void;
  onRestore: (snapshot: RehearsalSnapshot) => void;
  onDelete: (snapshotId: string) => void;
}

const TYPE_LABEL: Record<SnapshotDiffEntry['type'], string> = {
  added: '新增',
  removed: '删除',
  moved: '移动',
  duration: '时长',
};

function fmtRange(b?: { start: number; end: number }) {
  return b ? `[${fmtSec(b.start)}, ${fmtSec(b.end)})` : '';
}

const round1 = (v: number) => Math.round(v * 10) / 10;

/**
 * 排练快照面板：命名保存当前工程快照（冻结声部 / 歌手 / 换气区间），
 * 展开任意快照可查看与当前工程按歌手 ID 对齐的区间差异（按时间排序），
 * 恢复需在同一快照上二次确认；恢复后由 App 清除选中段与接力预览，节拍图保持现状。
 */
export default function SnapshotPanel({ project, snapshots, onCreate, onRestore, onDelete }: Props) {
  const [name, setName] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  /** 进入「再次点击确认恢复」状态的快照 id（4 秒内有效） */
  const [armedId, setArmedId] = useState<string | null>(null);

  useEffect(() => {
    if (!armedId) return;
    const t = window.setTimeout(() => setArmedId(null), 4000);
    return () => window.clearTimeout(t);
  }, [armedId]);

  // 快照被删除后收起 / 解除待确认状态
  useEffect(() => {
    if (!snapshots.some((s) => s.id === expandedId)) setExpandedId(null);
    if (!snapshots.some((s) => s.id === armedId)) setArmedId(null);
  }, [snapshots, expandedId, armedId]);

  const save = () => {
    onCreate(name);
    setName('');
  };

  return (
    <section className="side-section snapshot-section">
      <h3>📸 排练快照</h3>
      <p className="hint">保存带名称的当前工程快照，冻结声部、歌手与换气区间；可随时对比差异并在确认后恢复（节拍图保持现状）。</p>
      <div className="snapshot-create">
        <input
          value={name}
          placeholder="快照名称（可留空自动命名）"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') save();
          }}
        />
        <button className="primary" onClick={save}>
          保存快照
        </button>
      </div>

      {snapshots.length === 0 && <p className="hint">暂无快照，保存后可在此对比与恢复。</p>}

      <ul className="snapshot-list">
        {snapshots.map((snap) => (
          <SnapshotItem
            key={snap.id}
            project={project}
            snapshot={snap}
            expanded={expandedId === snap.id}
            armed={armedId === snap.id}
            onToggle={() => {
              setExpandedId((cur) => (cur === snap.id ? null : snap.id));
              setArmedId(null);
            }}
            onRestore={() => {
              if (armedId === snap.id) {
                onRestore(snap);
                setArmedId(null);
                setExpandedId(null);
              } else {
                setArmedId(snap.id);
              }
            }}
            onDelete={() => onDelete(snap.id)}
          />
        ))}
      </ul>
    </section>
  );
}

function SnapshotItem({
  project,
  snapshot,
  expanded,
  armed,
  onToggle,
  onRestore,
  onDelete,
}: {
  project: Project;
  snapshot: RehearsalSnapshot;
  expanded: boolean;
  armed: boolean;
  onToggle: () => void;
  onRestore: () => void;
  onDelete: () => void;
}) {
  const diffs = useMemo(
    () => (expanded ? diffProjectSnapshot(project, snapshot) : null),
    [expanded, project, snapshot],
  );
  const structure = useMemo(
    () => (expanded ? diffStructure(project, snapshot) : null),
    [expanded, project, snapshot],
  );
  const counts = useMemo(() => {
    if (!diffs) return null;
    return {
      added: diffs.filter((d) => d.type === 'added').length,
      removed: diffs.filter((d) => d.type === 'removed').length,
      moved: diffs.filter((d) => d.type === 'moved').length,
      duration: diffs.filter((d) => d.durationChanged).length,
    };
  }, [diffs]);

  const date = new Date(snapshot.createdAt);
  const totalBreaths = snapshot.singers.reduce((acc, s) => acc + s.breaths.length, 0);

  return (
    <li className="snapshot-item">
      <div className="snapshot-head">
        <button className="snapshot-toggle" title={expanded ? '收起差异' : '展开差异'} onClick={onToggle}>
          {expanded ? '▾' : '▸'}
        </button>
        <div className="snapshot-meta">
          <b>{snapshot.name}</b>
          <span className="muted">
            {date.toLocaleString('zh-CN', { hour12: false })} · {snapshot.singers.length} 歌手 / {totalBreaths} 段
            {snapshot.projectName !== project.name && <em> · 曲名：{snapshot.projectName}</em>}
          </span>
        </div>
        <button
          className={armed ? 'danger' : ''}
          title="恢复快照：用快照中的声部、歌手与换气区间替换当前工程（节拍图保持现状）"
          onClick={onRestore}
        >
          {armed ? '再次点击确认' : '恢复'}
        </button>
        <button className="icon-btn" title="删除快照" onClick={onDelete}>
          ✕
        </button>
      </div>

      {expanded && diffs && counts && structure && (
        <div className="snapshot-diff">
          <div className="snapshot-counts muted">
            区间差异：<span className="ok">新增 {counts.added}</span> · <span className="bad">删除 {counts.removed}</span>{' '}
            · <span className="diff-move">移动 {counts.moved}</span> · <span className="diff-duration">时长 {counts.duration}</span>
            {(structure.addedSingers.length > 0 ||
              structure.removedSingers.length > 0 ||
              structure.addedParts.length > 0 ||
              structure.removedParts.length > 0) && (
              <span>
                {' '}
                · 歌手：
                {structure.addedSingers.length > 0 && <span className="ok">＋{structure.addedSingers.length} </span>}
                {structure.removedSingers.length > 0 && <span className="bad">−{structure.removedSingers.length} </span>}
                声部：
                {structure.addedParts.length > 0 && <span className="ok">＋{structure.addedParts.length} </span>}
                {structure.removedParts.length > 0 && <span className="bad">−{structure.removedParts.length}</span>}
              </span>
            )}
          </div>
          {diffs.length === 0 ? (
            <p className="hint ok">与当前工程无换气区间差异。</p>
          ) : (
            <ul className="diff-list">
              {diffs.map((d) => (
                <li key={`${d.type}-${d.intervalId}`} className={`diff-row diff-${d.type}`}>
                  <span className="diff-tag">{TYPE_LABEL[d.type]}</span>
                  <span className="diff-singer">{d.singerName}</span>
                  <span className="diff-range">
                    {d.type === 'added' && <>{fmtRange(d.after)}</>}
                    {d.type === 'removed' && <>{fmtRange(d.before)}</>}
                    {d.type === 'moved' && (
                      <>
                        {fmtRange(d.before)} → {fmtRange(d.after)}
                        <em className="diff-move"> 起点 {fmtOffset(round1(d.after!.start - d.before!.start))}</em>
                        {d.durationChanged && (
                          <em className="diff-duration">
                            {' '}
                            时长 {fmtSec(d.before!.end - d.before!.start)} → {fmtSec(d.after!.end - d.after!.start)}
                          </em>
                        )}
                      </>
                    )}
                    {d.type === 'duration' && (
                      <>
                        {fmtRange(d.before)} → {fmtRange(d.after)}
                        <em className="diff-duration">
                          {' '}
                          时长 {fmtSec(d.before!.end - d.before!.start)} → {fmtSec(d.after!.end - d.after!.start)}
                        </em>
                      </>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {armed && (
            <p className="snapshot-confirm bad">
              ⚠ 将用「{snapshot.name}」替换当前声部、歌手与换气区间；节拍图、曲名与全曲时长保持现状。再次点击「恢复」确认，
              4 秒内未确认自动取消。
            </p>
          )}
        </div>
      )}
    </li>
  );
}
