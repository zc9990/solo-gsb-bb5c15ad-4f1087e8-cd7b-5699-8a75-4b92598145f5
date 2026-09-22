/** 换气区间：半开区间 [start, end)，单位秒。歌手在该区间内不发声。 */
export interface BreathInterval {
  id: string;
  /** 起始秒（含） */
  start: number;
  /** 结束秒（不含） */
  end: number;
}

export interface Singer {
  id: string;
  name: string;
  partId: string;
  /**
   * 最长连续发声秒数：累计连续发声达到该值后即进入疲劳（0 = 停用疲劳检查）。
   * 只有时长 ≥ recoveryBreathSec 的换气才会清零累计；较短换气只暂停累计。
   */
  maxSustainSec: number;
  /**
   * 有效恢复换气秒数：换气时长达到该值才算有效恢复、清零累计（0 = 任意换气都清零）。
   * maxSustainSec 为 0 时本项无意义。
   */
  recoveryBreathSec: number;
  breaths: BreathInterval[];
}

export interface VoicePart {
  id: string;
  name: string;
  color: string;
  /** 该声部任意时刻的最低发声人数 */
  minSingers: number;
}

/**
 * 变速点：从指定小节的首拍起速度变为 bpm（分段恒速）。
 * measure 为 1 起算的小节号，同一拍位上至多一个变速点。
 */
export interface TempoChange {
  id: string;
  measure: number;
  bpm: number;
}

/** 节拍图：拍号 + 起始速度 + 变速点列表。 */
export interface BeatMap {
  /** 每小节拍数（拍号分子） */
  beatsPerBar: number;
  /** 以几分音符为一拍（拍号分母，仅用于显示） */
  beatUnit: number;
  /** 起始 BPM（第 1 小节首拍起） */
  startBpm: number;
  /** 变速点（按小节号升序、不重复；measure=1 的条目等价于起始 BPM） */
  changes: TempoChange[];
}

export interface Project {
  name: string;
  /** 全曲时长（秒） */
  duration: number;
  /** 节拍图（旧工程缺省时为 4/4、120 BPM） */
  beatMap: BeatMap;
  parts: VoicePart[];
  singers: Singer[];
}

/**
 * 排练快照：冻结保存时刻的声部、歌手与换气区间（均为深拷贝，之后工程改动不影响快照）。
 * 节拍图 / 曲名 / 全曲时长不在冻结范围内——恢复快照时这些字段保持当前工程现状。
 */
export interface RehearsalSnapshot {
  id: string;
  /** 用户命名的快照名称（缺省时自动生成） */
  name: string;
  /** 创建时间（epoch 毫秒） */
  createdAt: number;
  /** 保存时的曲名（仅展示用，恢复时不覆盖当前曲名） */
  projectName: string;
  parts: VoicePart[];
  singers: Singer[];
}

/** 当前选中的换气段 */
export interface Selection {
  singerId: string;
  intervalId: string;
}
