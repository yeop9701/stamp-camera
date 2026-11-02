// 아이콘 PNG 생성 (헤드리스 크롬 canvas 사용). 크롬을 9222 포트로 띄운 뒤: node tests/make-icons.mjs
import { connect, finish } from './cdp.mjs';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const OUT = fileURLToPath(new URL('../icons/', import.meta.url));
const cdp = await connect(9222);
const draw = (size, maskable) => cdp.evaluate(`(() => {
  const S = ${size}, c = document.createElement('canvas'); c.width = c.height = S;
  const g = c.getContext('2d');
  const k = ${maskable} ? 0.78 : 1;             // maskable은 안전 영역(가운데 80%) 안에 그린다
  g.fillStyle = '#1c1c1e';
  if (${maskable}) g.fillRect(0, 0, S, S);
  else { g.beginPath(); g.roundRect(0, 0, S, S, S * 0.22); g.fill(); }
  g.translate(S / 2, S / 2); g.scale(k, k); g.translate(-S / 2, -S / 2);
  // 카메라 몸체
  g.fillStyle = '#f2f2f2';
  g.beginPath(); g.roundRect(S*.14, S*.30, S*.72, S*.50, S*.08); g.fill();
  g.beginPath(); g.roundRect(S*.36, S*.22, S*.28, S*.12, S*.03); g.fill();
  // 렌즈
  g.fillStyle = '#1c1c1e'; g.beginPath(); g.arc(S*.5, S*.55, S*.17, 0, Math.PI*2); g.fill();
  g.fillStyle = '#5a5a60'; g.beginPath(); g.arc(S*.5, S*.55, S*.11, 0, Math.PI*2); g.fill();
  // 번호 스탬프
  g.fillStyle = '#ffcc00'; g.beginPath(); g.roundRect(S*.06, S*.08, S*.42, S*.2, S*.04); g.fill();
  g.fillStyle = '#000'; g.font = 'bold ' + (S*.15) + 'px Arial, sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('007', S*.27, S*.185);
  return c.toDataURL('image/png').split(',')[1];
})()`);
for (const [name, size, m] of [['icon-192.png', 192, false], ['icon-512.png', 512, false], ['icon-maskable-512.png', 512, true]]) {
  writeFileSync(OUT + name, Buffer.from(await draw(size, m), 'base64'));
  console.log('wrote', name);
}
finish(cdp);
