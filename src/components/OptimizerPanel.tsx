import type { Project, Selection } from '../types';
import type { OptimizeResult } from '../lib/optimize';
import { fmtOffset, fmtSec } from '../lib/format';
import { fmtTimeAsBeat } from '../lib/tempo';

interface Props {
  project: Project;
  selection: Selection | null;
  range: number;
  onRangeChange: (n: number) => void;
  result: OptimizeResult | null;
  previewOffset: number | null;
  onRun: () => void;
  onPreview: (offset: number) => void;
  onApply: () => void;
  onCancel: () => void;
  onDelete: () => void;
}

export default function OptimizerPanel(props: Props) {
  const { project, selection, result, previewOffset } = props;
  const singer = selection ? project.singers.find((s) => s.id === selection.singerId) : undefined;
  const interval = singer?.breaths.find((b) => b.id === selection?.intervalId);
  const part = singer ? project.parts.find((p) => p.id === singer.partId) : undefined;

  const previewed =
    result?.candidates.find((c) => c.offset === previewOffset) ?? result?.best ?? null;
  const improved = result && previewed ? result.baseline - previewed.underSeconds : 0;

  return (
    <section className="optimizer">
      <h3>🛠 换气段寻优（±N 秒整数穷举）</h3>
      {!singer || !interval ? (
        <p className="hint">
          在时间轴上点击一个换气段进行选择；随后在此设置搜索范围并穷举所有可行位置，
          依次最小化「全曲未达标总秒数 → 位移量」，平局取更早时刻。
        </p>
      ) : (
        <div className="opt-body">
          <div className="opt-info">
            <div>
              已选：<b>{singer.name}</b>（{part?.name ?? '未知声部'}） · 区间 [{fmtSec(interval.start)},{' '}
              {fmtSec(interval.end)}) · 时长 {fmtSec(interval.end - interval.start)}
              <span className="muted">
                {' '}
                · 拍位 {fmtTimeAsBeat(interval.start, project.beatMap)} –{' '}
                {fmtTimeAsBeat(interval.end, project.beatMap)}
              </span>
            </div>
            <div className="range-row">
              <span>搜索范围 ±</span>
              <input
                type="number"
                min={0}
                max={60}
                value={props.range}
                onChange={(e) => {
                  const n = Math.round(Number(e.target.value));
                  if (Number.isFinite(n)) props.onRangeChange(Math.min(60, Math.max(0, n)));
                }}
              />
              <span>秒（整数位移）</span>
              <button className="primary" onClick={props.onRun}>
                穷举寻优
              </button>
              <button className="danger" onClick={props.onDelete}>
                删除该换气段
              </button>
            </div>
          </div>

          {result && previewed && (
            <div className="opt-result">
              <div className="diff">
                <span>
                  修复前未达标 <b>{result.baseline.toFixed(1)}s</b>
                </span>
                <span className="arrow">→</span>
                <span>
                  修复后{' '}
                  <b className={previewed.underSeconds < result.baseline ? 'ok' : ''}>
                    {previewed.underSeconds.toFixed(1)}s
                  </b>
                </span>
                <span className={improved > 0 ? 'ok badge' : 'badge'}>
                  {improved > 0 ? `改善 ${improved.toFixed(1)}s` : '无改善'}
                </span>
              </div>
              <div className="best-line">
                最优解：位移 <b>{fmtOffset(result.best.offset)}</b> → 新区间 [{fmtSec(result.best.start)},{' '}
                {fmtSec(result.best.end)})
                {result.best.offset === 0 && <em>（当前位置已是最优）</em>}
              </div>
              <div className="stats">
                共 {result.candidates.length} 个可行位移（越界排除 {result.infeasible.bounds} 个，重叠排除{' '}
                {result.infeasible.overlap} 个）· 点击下表任意行可切换预览
              </div>
              <table className="cand-table">
                <thead>
                  <tr>
                    <th>位移</th>
                    <th>新区间</th>
                    <th>全曲未达标</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {result.candidates.slice(0, 8).map((c) => (
                    <tr
                      key={c.offset}
                      className={c.offset === previewOffset ? 'active' : ''}
                      onClick={() => props.onPreview(c.offset)}
                    >
                      <td>{fmtOffset(c.offset)}</td>
                      <td>
                        [{fmtSec(c.start)}, {fmtSec(c.end)})
                      </td>
                      <td>{c.underSeconds.toFixed(1)}s</td>
                      <td>{c.offset === result.best.offset ? '★ 最优' : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="opt-actions">
                <button className="primary" onClick={props.onApply} disabled={previewOffset === null}>
                  应用预览（{fmtOffset(previewed.offset)}）
                </button>
                <button onClick={props.onCancel}>取消</button>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
