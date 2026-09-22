import type { Project } from '../types';
import { uid } from './id';

/**
 * 示例工程：96 秒四部合唱。
 * 女高/女低各 3 人（需 ≥2 人发声），男高/男低各 2 人（需 ≥1 人发声），
 * 换气段故意安排了若干重叠，用于演示未达标标红与自动寻优。
 * 节拍图 4/4、起始 120 BPM；第 17 小节首拍变速到 90 BPM、第 33 小节回到 120，
 * 用于演示跨变速点的双向换算与按拍吸附（换气段的秒位置不随之改变）。
 *
 * 部分歌手开启了「持续发声疲劳」检查（最长连续发声 / 有效恢复换气秒数），
 * 其余歌手保持 0 = 停用，用于演示橙色疲劳警示层与侧栏汇总。
 */
export function createSampleProject(): Project {
  const parts = [
    { id: uid(), name: '女高音', color: '#f472b6', minSingers: 2 },
    { id: uid(), name: '女低音', color: '#a78bfa', minSingers: 2 },
    { id: uid(), name: '男高音', color: '#60a5fa', minSingers: 1 },
    { id: uid(), name: '男低音', color: '#34d399', minSingers: 1 },
  ];
  /**
   * @param limits [最长连续发声秒, 有效恢复换气秒]，省略或 [0,0] 表示停用
   */
  const mk = (
    name: string,
    partIdx: number,
    breaths: [number, number][],
    limits: [number, number] = [0, 0],
  ) => ({
    id: uid(),
    name,
    partId: parts[partIdx].id,
    maxSustainSec: limits[0],
    recoveryBreathSec: limits[1],
    breaths: breaths.map(([start, end]) => ({ id: uid(), start, end })),
  });
  return {
    name: '示例 · 四部合唱《远方的风》',
    duration: 96,
    beatMap: {
      beatsPerBar: 4,
      beatUnit: 4,
      startBpm: 120,
      changes: [
        { id: uid(), measure: 17, bpm: 90 },
        { id: uid(), measure: 33, bpm: 120 },
      ],
    },
    parts,
    singers: [
      // 王芳：上限 25s、恢复需 3s：三次换气都恰为 3s（有效恢复），发声段最长 23s → 不疲劳（启用但达标）
      mk('王芳', 0, [[18, 21], [44, 47], [70, 73]], [25, 3]),
      // 李雪：上限 30s、恢复需 3s：[19,22)、[50,53) 均有效恢复；53→96 发声 43s → [83,96)
      mk('李雪', 0, [[19, 22], [50, 53]], [30, 3]),
      // 赵敏：上限 44s、任意换气即恢复：曲首到首次换气恰好发声 44s（半开边界，相等不算越界）→ 不疲劳
      mk('赵敏', 0, [[44, 46], [76, 79]], [44, 0]),
      // 陈静：上限 28s、恢复需 5s：[30,33) 3s、[60,64) 4s 都是短换气（只暂停、不清零）
      // → t=28 起疲劳，累计持续到曲终都没有效恢复：[28,96)
      mk('陈静', 1, [[30, 33], [60, 64]], [28, 5]),
      // 刘洋：上限 20s、恢复需 2s：[31,34) 有效恢复 → [20,31)；34→96 发声 62s → [54,96)（两段警示）
      mk('刘洋', 1, [[31, 34]], [20, 2]),
      mk('孙丽', 1, [[60, 63]]),
      // 周杰：上限 40s：曲首到 [40,43) 恰好 40s（相等不越界），换气有效恢复；43→96 发声 53s → [83,96)
      mk('周杰', 2, [[40, 43]], [40, 2]),
      mk('吴强', 2, [[41, 44]]),
      mk('郑伟', 3, [[10, 13]]),
      mk('冯磊', 3, [[55, 58]]),
    ],
  };
}

