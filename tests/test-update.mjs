/* 새 버전 배포가 휴대폰에 실제로 반영되는지 검사.
   GitHub Pages처럼 파일을 10분 캐시(max-age=600)하는 서버에서
   ① 예전 버전(OLD_REF 커밋)을 설치해 쓰다가 ② 지금 작업본을 배포하면 새 버전이 뜨는지,
   ③ 그 뒤의 업데이트는 새로고침 없이 자동으로 적용되는지 본다.

   chrome --headless=new --remote-debugging-port=9222 ... (test-app.mjs와 같음)
   node tests/test-update.mjs [OLD_REF=26c5538]                                  */
import { connect, finish } from './cdp.mjs';
import { setTimeout as sleep } from 'node:timers/promises';
import { execSync, spawn } from 'node:child_process';
import { cpSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const OLD_REF = process.argv[2] || '26c5538';
const REPO = fileURLToPath(new URL('../', import.meta.url));
const SITE = join(fileURLToPath(new URL('./out/', import.meta.url)), 'update-site');
const PORT = 8124;
const APP = `http://localhost:${PORT}/`;
const APP_FILES = ['index.html', 'manifest.webmanifest', 'sw.js', 'css', 'js', 'icons'];

rmSync(SITE, { recursive: true, force: true });
mkdirSync(SITE, { recursive: true });
execSync(`git archive ${OLD_REF} | tar -x -C "${SITE.replace(/\\/g, '/')}"`, { cwd: REPO, shell: 'bash' });
const oldVersion = /APP_VERSION = '([^']+)'/.exec(readFileSync(join(SITE, 'js/app.js'), 'utf8'))[1];
const newVersion = /APP_VERSION = '([^']+)'/.exec(readFileSync(join(REPO, 'js/app.js'), 'utf8'))[1];

const server = spawn(process.execPath, [join(REPO, 'tests/serve.mjs'), String(PORT), SITE, '--pages'], { stdio: 'ignore' });
await sleep(500);

const cdp = await connect(9222);
const ev = (s) => cdp.evaluate(s);
let fails = 0, passes = 0;
const ok = (cond, msg, extra) => {
  if (cond) passes++; else fails++;
  console.log((cond ? '  OK   ' : '  FAIL ') + msg + (!cond && extra !== undefined ? '  → ' + JSON.stringify(extra) : ''));
};
const waitFor = async (expr, ms = 10000) => {
  for (let t = 0; t < ms; t += 150) {
    try { if (await ev(expr)) return true; } catch (e) { /* 새로고침 중 */ }
    await sleep(150);
  }
  return false;
};
const version = () => ev(`(document.getElementById('appVersion') || {}).textContent`).catch(() => null);
const open = async () => { await cdp.send('Page.navigate', { url: APP }); await sleep(1200); };

// 앞선 실행이 남긴 브라우저 HTTP 캐시(10분)를 비운다 — 안 비우면 예전 버전 대신 그 파일이 설치된다
await cdp.send('Network.enable');
await cdp.send('Network.clearBrowserCache');

console.log(`\n[1] 예전 버전 v${oldVersion} 설치 (${OLD_REF})`);
await open();
ok(await waitFor(`!!navigator.serviceWorker.controller`), '서비스워커 설치됨');
await open();
ok((await version()) === 'v' + oldVersion, `v${oldVersion} 실행 중`, await version());

console.log(`\n[2] 새 버전 v${newVersion} 배포 → 앱 다시 열기`);
for (const f of APP_FILES) cpSync(join(REPO, f), join(SITE, f), { recursive: true });
let seen = [];
for (let i = 0; i < 3; i++) {
  await open();
  seen.push(await version());
  if (seen.at(-1) === 'v' + newVersion) break;
  await sleep(1500);
}
console.log('       다시 열 때마다 보인 버전:', seen.join(' → '));
ok(seen.at(-1) === 'v' + newVersion, `다시 열면 v${newVersion}로 바뀜 (${seen.length}번 만에)`, seen);
ok(await ev(`!!document.getElementById('s-numberOn') && !!document.getElementById('btnFlash')`), '새 기능(번호 표시 끄기, 플래시 버튼)이 화면에 있음');
const cached = await ev(`(async () => { const keys = await caches.keys(); const c = await caches.open(keys.find((k) => k.endsWith('${newVersion}')) || keys[0]);
  const r = await c.match('js/app.js'); return r ? (await r.text()).includes("APP_VERSION = '${newVersion}'") : null; })()`);
ok(cached === true, '오프라인 캐시에도 새 버전 파일이 들어감 (옛 파일 섞이지 않음)', cached);

console.log('\n[3] 그다음 업데이트는 앱을 켜 둔 채로 자동 적용');
const next = newVersion.replace(/(\d+)$/, (n) => String(Number(n) + 1));
for (const f of ['js/app.js', 'sw.js']) {
  const p = join(SITE, f);
  writeFileSync(p, readFileSync(p, 'utf8').replace(`'${newVersion}'`, `'${next}'`).replace(`'v${newVersion}'`, `'v${next}'`));
}
await ev(`(window.__beforeUpdate = true)`);
// 앱을 다시 볼 때(visibilitychange) 하는 업데이트 확인과 같은 호출
await ev(`navigator.serviceWorker.getRegistration().then((r) => r.update()).then(() => true)`);
ok(await waitFor(`!window.__beforeUpdate && document.getElementById('appVersion').textContent === 'v${next}'`, 15000),
  `새로고침 안 해도 v${next}로 자동 전환`, await version());

console.log('\n[4] 오프라인에서도 열림');
await cdp.send('Network.enable');
await cdp.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
await open();
ok((await version()) === 'v' + next, '오프라인 실행', await version());
await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });

// 다음 실행을 위해 이 주소의 서비스워커·캐시 정리
await ev(`(async () => { for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister();
  for (const k of await caches.keys()) await caches.delete(k); return true; })()`);
server.kill();
console.log(`\n결과: ${passes} 통과, ${fails} 실패`);
finish(cdp, fails ? 1 : 0);
