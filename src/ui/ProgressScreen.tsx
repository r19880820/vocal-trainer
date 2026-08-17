// 成長記録画面(Phase 7)。文言・表示ルールの正本は docs/UX_TRAINING.md「7. 成長記録画面」。
// ui/ → core/ の公開APIのみ・data/ 経由でストレージを参照(ARCHITECTURE.md 依存ルール)。
import type { ProgressStore } from '../data/progressStore';
import { compareLatestWeeks, noteBreakdown, weeklyBySkill, type Trend } from '../core/progress/aggregate';
import { midiToSolfege } from '../core/pitch/scale';
import { NOTE_GOOD_CENTS, NOTE_MIN_COUNT, NOTE_OK_CENTS, PARAMS_VERSION } from '../core/constants';
import { SONGS } from '../core/exercise/songs';
import type { SkillSnapshot } from '../core/types';

/** ドレミ表記+オクターブ番号(音域チェックRC-3と同様の表示専用ヘルパー)。 */
function noteName(midi: number): string {
  return `${midiToSolfege(midi)}${Math.floor(Math.round(midi) / 12) - 1}`;
}

/** 音ごとの評価ラベル(UX §7「音ごとのようす」— 赤・ネガ語を使わない)。 */
function noteRating(medianAbsCents: number): string {
  if (medianAbsCents <= NOTE_GOOD_CENTS) return '◎ とくい';
  if (medianAbsCents <= NOTE_OK_CENTS) return '○ まあまあ';
  return '△ これから';
}

const page: React.CSSProperties = {
  padding: 20,
  fontFamily: 'sans-serif',
  maxWidth: 440,
  margin: '0 auto',
  minHeight: '100dvh',
  boxSizing: 'border-box',
};
const card: React.CSSProperties = {
  background: '#f4f4f6',
  borderRadius: 14,
  padding: '16px 18px',
  marginTop: 16,
};
const subBtn: React.CSSProperties = {
  display: 'block',
  width: '100%',
  fontSize: 20,
  padding: '16px 20px',
  borderRadius: 14,
  border: 'none',
  background: '#e8eaee',
  color: '#333',
  marginTop: 16,
  cursor: 'pointer',
};

interface SkillDef {
  id: string;
  label: string;
  /** medianAbsCents等、数値の意味を添える一言(常時表示) */
  note?: string;
  higherIsBetter: boolean;
  format: (v: number) => string;
}

// UX_TRAINING.md「7. 成長記録画面」のラベル定義が正本
const SKILLS: SkillDef[] = [
  { id: 'pitchAccuracy', label: '音の高さ', higherIsBetter: true, format: (v) => `${Math.round(v * 100)}%` },
  {
    id: 'medianAbsCents',
    label: 'ズレの平均',
    note: '数値が小さいほど、目標の高さに近いです',
    higherIsBetter: false,
    format: (v) => `${Math.round(v)}`,
  },
  { id: 'pitchStability', label: '声の安定', higherIsBetter: true, format: (v) => `${Math.round(v * 100)}%` },
  { id: 'attackAccuracy', label: '音の入り', higherIsBetter: true, format: (v) => `${Math.round(v * 100)}%` },
  { id: 'directionAccuracy', label: '音の上下', higherIsBetter: true, format: (v) => `${Math.round(v * 100)}%` },
  { id: 'intervalAccuracy', label: '音程の幅', higherIsBetter: true, format: (v) => `${Math.round(v * 100)}%` },
];

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

interface SongStat {
  songId: string;
  medianAccuracy: number;
  count: number;
}

/**
 * skillId `melodyAccuracy:<songId>` の snapshot を曲ごとに集計する(Level4Screen.tsx が記録元)。
 * core/progress/aggregate.ts の noteBreakdown と同じ考え方だが、level4.ts/songs.ts 同様
 * core/ 側ファイルは変更しない制約のため、UI側にローカル実装する(詳細は最終報告)。
 */
function melodyBreakdown(snapshots: SkillSnapshot[]): SongStat[] {
  const PREFIX = 'melodyAccuracy:';
  const bySong = new Map<string, number[]>();
  for (const s of snapshots) {
    if (s.paramsVersion !== PARAMS_VERSION) continue;
    if (!s.skillId.startsWith(PREFIX)) continue;
    const songId = s.skillId.slice(PREFIX.length);
    const arr = bySong.get(songId);
    if (arr) arr.push(s.value);
    else bySong.set(songId, [s.value]);
  }
  return [...bySong.entries()].map(([songId, values]) => ({
    songId,
    medianAccuracy: median(values),
    count: values.length,
  }));
}

function arrowFor(trend: Trend | null): string {
  if (trend === 'up') return '↗';
  if (trend === 'down') return '↘';
  return '→';
}

export function ProgressScreen({ store, onBack }: { store: ProgressStore; onBack: () => void }) {
  const practiceCount = store.practiceCount();

  // データが無い場合の空状態(UX_TRAINING.md §1.5: 責めない・不安を煽らない)。
  // 判定は practiceCount(=pitchAccuracy件数)ではなく全snapshot数で行う — Level 4のみ
  // 練習したユーザー(melodyAccuracy:*しか無い)を締め出さない(Codexレビュー中)
  if (store.loadAll().length === 0) {
    return (
      <div style={page}>
        <h2 style={{ fontSize: 20 }}>せいちょう</h2>
        <p>練習するとここに成長が表示されます</p>
        <button style={subBtn} onClick={onBack}>
          ← もどる
        </button>
      </div>
    );
  }

  const weekly = weeklyBySkill(store.loadAll());

  return (
    <div style={page}>
      <h2 style={{ fontSize: 20 }}>せいちょう</h2>
      <p>これまで {practiceCount} 回練習しました</p>
      {SKILLS.map((skill) => {
        const points = weekly[skill.id] ?? [];
        if (points.length === 0) return null; // まだこの指標のデータがない(pitchStability/attackAccuracyはnull回が続くとあり得る)
        const current = points[0];
        const cmp = compareLatestWeeks(points, skill.higherIsBetter);
        return (
          <div style={card} key={skill.id}>
            <div style={{ fontSize: 14, color: '#888' }}>{skill.label}</div>
            {skill.note && <div style={{ fontSize: 12, color: '#aaa' }}>{skill.note}</div>}
            <div style={{ fontSize: 20, fontWeight: 700, marginTop: 4 }}>
              今週 {skill.format(current.median)}
              {cmp.previous && (
                <span style={{ fontSize: 15, fontWeight: 400, color: '#666' }}>
                  {'  '}
                  {arrowFor(cmp.trend)} 先週 {skill.format(cmp.previous.median)}
                </span>
              )}
            </div>
            {!cmp.previous && (
              <p style={{ fontSize: 13, color: '#888', marginTop: 4 }}>
                練習を続けると、ここに先週との変化が表示されます
              </p>
            )}
            {cmp.trend === 'down' && (
              <p style={{ fontSize: 13, color: '#888', marginTop: 4 }}>調子には波があります。続けていきましょう</p>
            )}
          </div>
        );
      })}
      {(() => {
        // 音ごとのようす(2026-08-16 ユーザー要望「どの音程でイマイチなのかが出るといい」)
        const notes = noteBreakdown(store.loadAll()).filter((n) => n.count >= NOTE_MIN_COUNT);
        return (
          <div style={card}>
            <div style={{ fontSize: 14, color: '#888' }}>音ごとのようす(音の高さ合わせ)</div>
            {notes.length === 0 ? (
              <p style={{ fontSize: 13, color: '#888', marginTop: 8 }}>
                同じ音を2回以上練習すると、音ごとの「とくい・これから」がここに出てきます
              </p>
            ) : (
              <>
                {notes.map((n) => (
                  <div
                    key={n.midi}
                    style={{ display: 'flex', justifyContent: 'space-between', fontSize: 15, marginTop: 8 }}
                  >
                    <span style={{ fontWeight: 700 }}>{noteName(n.midi)}</span>
                    <span>
                      {noteRating(n.medianAbsCents)}
                      <span style={{ color: '#aaa', fontSize: 12 }}>({n.count}回)</span>
                    </span>
                  </div>
                ))}
                <p style={{ fontSize: 12, color: '#aaa', marginTop: 8 }}>
                  「これから」の音は伸びしろです。練習すると変わっていきます
                </p>
              </>
            )}
          </div>
        );
      })()}
      {(() => {
        // うたのフレーズ(Level 4)。データが無い曲・データが1件も無ければセクション自体を出さない
        // (UX_TRAINING.md §1.5: 空状態は不安を煽らない — 音ごとのようすの空状態と違い、
        // ここは「まだ0件」を案内する固定文言を出す仕様がタスクに含まれないため非表示にする)。
        const songStats = melodyBreakdown(store.loadAll());
        if (songStats.length === 0) return null;
        return (
          <div style={card}>
            <div style={{ fontSize: 14, color: '#888' }}>うたのフレーズ</div>
            {songStats.map((stat) => {
              const title = SONGS.find((s) => s.id === stat.songId)?.title ?? stat.songId;
              return (
                <div
                  key={stat.songId}
                  style={{ display: 'flex', justifyContent: 'space-between', fontSize: 15, marginTop: 8 }}
                >
                  <span style={{ fontWeight: 700 }}>{title}</span>
                  <span>
                    {Math.round(stat.medianAccuracy * 100)}%
                    <span style={{ color: '#aaa', fontSize: 12 }}>({stat.count}回)</span>
                  </span>
                </div>
              );
            })}
          </div>
        );
      })()}
      <button style={subBtn} onClick={onBack}>
        ← もどる
      </button>
    </div>
  );
}
