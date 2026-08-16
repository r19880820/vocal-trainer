// ルート: 通常はトレーニングUI。`?debug` で開発デバッグ画面(Phase 0.5 実機読み戻し確認用)。
import { DebugPage } from './DebugPage';
import { TrainingApp } from './TrainingApp';

export function App() {
  const debug = new URLSearchParams(window.location.search).has('debug');
  return debug ? <DebugPage /> : <TrainingApp />;
}
