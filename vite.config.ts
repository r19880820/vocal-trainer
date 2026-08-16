import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';

// HTTPS必須: getUserMedia は secure context でのみ動く(iPhoneから LAN 経由で開くため)
// base: GitHub Pages(https://r19880820.github.io/vocal-trainer/)配信時のみサブパスにする。
// ローカル開発は従来どおり '/'(CIが GHPAGES=1 を設定する)
export default defineConfig({
  plugins: [react(), basicSsl()],
  server: { host: true },
  base: process.env.GHPAGES ? '/vocal-trainer/' : '/',
});
