import { useRef } from 'react';
import type { BreathInterval } from '../types';
import type { Segment } from '../lib/coverage';
import { clamp, moveRange, resizeLeftRange, resizeRightRange, snap } from '../lib/constraints';
import { fmtSec } from '../lib/format';

interface Props {
  interval: BreathInterval;
  /** 同歌手的其它换气段（用于重叠约束） */
  others: Segment[];
  songDuration: number;
  pxPerSec: number;
  color: string;
  selected: boolean;
  /** 预览模式下原位置半透明显示 */
  dimmed: boolean;
  /** 自定义吸附函数（按拍吸附时由时间轴注入），缺省吸附到 0.1 秒 */
  snapFn?: (t: number) => number;
  /** 节拍标尺下的块内文本（如「2拍」） */
  beatLabel?: string | null;
  /** 节拍标尺下 tooltip 追加的拍位文本 */
  beatTitle?: string | null;
  onSelect: () => void;
  onChange: (start: number, end: number) => void;
}

type DragMode = 'move' | 'left' | 'right';

export default function BreathBlock(props: Props) {
  const { interval, others, songDuration, pxPerSec } = props;
  const toGrid = props.snapFn ?? snap;
  const drag = useRef<{ mode: DragMode; x0: number; start: number; end: number } | null>(null);

  const begin = (mode: DragMode) => (e: React.PointerEvent) => {
    e.stopPropagation();
    props.onSelect();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { mode, x0: e.clientX, start: interval.start, end: interval.end };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const delta = (e.clientX - d.x0) / pxPerSec;
    if (d.mode === 'move') {
      const { lo, hi } = moveRange(d.start, d.end, others, songDuration);
      const start = clamp(toGrid(d.start + delta), lo, hi);
      props.onChange(start, start + (d.end - d.start));
    } else if (d.mode === 'left') {
      const { lo, hi } = resizeLeftRange(d.start, d.end, others);
      const start = clamp(toGrid(d.start + delta), lo, hi);
      props.onChange(start, d.end);
    } else {
      const { lo, hi } = resizeRightRange(d.start, d.end, others, songDuration);
      const end = clamp(toGrid(d.end + delta), lo, hi);
      props.onChange(d.start, end);
    }
  };

  const endDrag = () => {
    drag.current = null;
  };

  const dur = interval.end - interval.start;
  const title = props.beatTitle
    ? `${props.beatTitle}\n换气 ${fmtSec(interval.start)} – ${fmtSec(interval.end)}（时长 ${fmtSec(dur)}）\n拖动移动，拖动两端调整时长`
    : `换气 ${fmtSec(interval.start)} – ${fmtSec(interval.end)}（时长 ${fmtSec(dur)}）\n拖动移动，拖动两端调整时长`;
  return (
    <div
      className={`breath-block${props.selected ? ' selected' : ''}${props.dimmed ? ' dimmed' : ''}`}
      style={{
        left: interval.start * pxPerSec,
        width: Math.max(4, dur * pxPerSec),
        background: props.color,
      }}
      title={title}
      onPointerDown={begin('move')}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="handle left" onPointerDown={begin('left')} />
      <span className="breath-label">{props.beatLabel ?? fmtSec(dur)}</span>
      <div className="handle right" onPointerDown={begin('right')} />
    </div>
  );
}
