// リアルタイムピッチインジケータ(正本: docs/UX_TRAINING.md §4)
// ±200cent表示・目標帯±50centハイライト・緑/琥珀/青灰の3ゾーン(赤は使わない)・100msイージング
import { useEffect, useRef, useState } from 'react';
import { DISPLAY_RANGE_CENTS, ZONE_NEAR_CENTS, ZONE_OK_CENTS } from '../core/constants';

interface Props {
  cents: number | null; // voiced でなければ null
}

const ZONE_COLORS = {
  ok: '#2e9e5b',
  near: '#d9a521',
  far: '#7a8699',
} as const;

type Zone = keyof typeof ZONE_COLORS;

function zoneOf(cents: number): Zone {
  const a = Math.abs(cents);
  if (a <= ZONE_OK_CENTS) return 'ok';
  if (a <= ZONE_NEAR_CENTS) return 'near';
  return 'far';
}

export function Indicator({ cents }: Props) {
  // ゾーン(色)の切替は150msヒステリシス(境界でのバタつき防止 — §4.4)
  const [zone, setZone] = useState<Zone>('far');
  const pendingRef = useRef<{ zone: Zone; since: number } | null>(null);

  useEffect(() => {
    if (cents === null) return;
    const z = zoneOf(cents);
    const now = performance.now();
    if (z === zone) {
      pendingRef.current = null;
      return;
    }
    if (pendingRef.current?.zone !== z) {
      pendingRef.current = { zone: z, since: now };
      return;
    }
    if (now - pendingRef.current.since >= 150) {
      setZone(z);
      pendingRef.current = null;
    }
  }, [cents, zone]);

  const clamped = cents === null ? 0 : Math.max(-DISPLAY_RANGE_CENTS, Math.min(DISPLAY_RANGE_CENTS, cents));
  const posPct = 50 + (clamped / DISPLAY_RANGE_CENTS) * 50; // 0..100
  const bandPct = (ZONE_OK_CENTS / DISPLAY_RANGE_CENTS) * 50; // 目標帯 片側%

  return (
    <div style={{ margin: '24px 0' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, color: '#888' }}>
        <span>低い</span>
        <span>高い</span>
      </div>
      <div
        style={{
          position: 'relative',
          height: 56,
          background: '#eef0f3',
          borderRadius: 28,
          overflow: 'hidden',
          marginTop: 4,
        }}
      >
        {/* 目標帯 ±50cent */}
        <div
          style={{
            position: 'absolute',
            left: `${50 - bandPct}%`,
            width: `${bandPct * 2}%`,
            top: 0,
            bottom: 0,
            background: 'rgba(46,158,91,0.15)',
          }}
        />
        {/* 目標マーカー */}
        <div
          style={{
            position: 'absolute',
            left: '50%',
            top: 0,
            bottom: 0,
            width: 2,
            background: 'rgba(46,158,91,0.6)',
            transform: 'translateX(-1px)',
          }}
        />
        {/* ユーザー位置ドット */}
        <div
          style={{
            position: 'absolute',
            left: `${posPct}%`,
            top: '50%',
            width: 32,
            height: 32,
            borderRadius: 16,
            transform: 'translate(-16px, -16px)',
            transition: 'left 100ms linear, background 300ms, opacity 250ms',
            background: cents === null ? 'transparent' : ZONE_COLORS[zone],
            border: cents === null ? '2px solid #b9bec7' : 'none',
            opacity: cents === null ? 0.6 : 1,
          }}
        />
      </div>
      <div style={{ textAlign: 'center', fontSize: 13, color: '#2e9e5b', marginTop: 4 }}>▲ 目標</div>
    </div>
  );
}
