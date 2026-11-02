/* 번호 스탬프 카메라 전체 흐름 검사 (가짜 카메라로 실제 브라우저에서 실행).
   node tests/serve.mjs 8123
   chrome --headless=new --remote-debugging-port=9222 --user-data-dir=<임시폴더>
          --use-fake-device-for-media-stream --use-fake-ui-for-media-stream about:blank
   node tests/test-app.mjs                                                         */
import { connect, click, shot, finish } from './cdp.mjs';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdirSync, readdirSync, rmSync, statSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const APP = process.env.APP_URL || 'http://localhost:8123/';
const OUT = fileURLToPath(new URL('./out/', import.meta.url));
const DL = OUT + 'downloads\\';
rmSync(OUT, { recursive: true, force: true });
mkdirSync(DL, { recursive: true });

const cdp = await connect(9222);
const ev = (s) => cdp.evaluate(s);
let fails = 0, passes = 0;
const ok = (cond, msg, extra) => {
  if (cond) passes++; else fails++;
  console.log((cond ? '  OK   ' : '  FAIL ') + msg + (!cond && extra !== undefined ? '  → ' + JSON.stringify(extra) : ''));
};
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), msg, { 실제: a, 바람: b });
const errors = [];
cdp.ws.addEventListener('message', (m) => {
  const d = JSON.parse(m.data);
  if (d.method === 'Runtime.exceptionThrown') errors.push(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text);
  if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') errors.push(d.params.args.map((a) => a.value ?? a.description).join(' '));
});

const center = (sel) => ev(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
const tap = async (sel) => { const p = await center(sel); await click(cdp, p.x, p.y); };
const text = (sel) => ev(`document.querySelector(${JSON.stringify(sel)}).textContent`);
const downloads = () => readdirSync(DL).filter((f) => !f.endsWith('.crdownload') && !f.endsWith('.tmp'));
const waitFor = async (expr, ms = 8000) => {
  for (let t = 0; t < ms; t += 100) {
    try { if (await ev(expr)) return true; } catch (e) { /* 새로고침 중 */ }
    await sleep(100);
  }
  return false;
};
const setVal = (id, v) => ev(`(() => { const el = document.getElementById(${JSON.stringify(id)});
  if (el.type === 'checkbox') el.checked = ${JSON.stringify(v)}; else el.value = ${JSON.stringify(String(v))};
  el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);

await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL, eventsEnabled: true });
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true });

await cdp.send('Page.navigate', { url: APP });
await sleep(1000);
await ev(`(async () => { localStorage.clear(); indexedDB.deleteDatabase('stampcam');
  for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister();
  for (const k of await caches.keys()) await caches.delete(k); return true; })()`);
await cdp.send('Page.navigate', { url: APP });

console.log('\n[1] 시작 화면');
ok(await waitFor(`document.getElementById('video').videoWidth > 0`), '카메라 미리보기 시작');
await sleep(500);
eq(await text('#nextText'), '001', '다음 번호 001');
ok(await ev(`!document.getElementById('overlay').hidden && document.getElementById('overlay').width > 0`), '스탬프 오버레이 표시');
ok(await ev(`document.getElementById('camFallback').hidden`), '대체 화면 숨김');
ok(await ev(`document.getElementById('btnUndo').disabled`), '되돌리기 비활성');
const geo = await ev(`(() => { const v = document.getElementById('video'), o = document.getElementById('overlay').getBoundingClientRect();
  return { vr: v.videoWidth / v.videoHeight, or: o.width / o.height }; })()`);
ok(Math.abs(geo.vr - geo.or) < 0.01, '오버레이 비율 = 영상 비율', geo);
await shot(cdp, OUT + '1-start.png');

console.log('\n[2] 촬영 → 자동 다운로드 + 목록 보관, 번호 증가');
await tap('#btnShutter');
ok(await waitFor(`document.getElementById('nextText').textContent === '002'`), '촬영 후 다음 번호 002');
await sleep(1200);
let dl = downloads();
eq(dl.length, 1, '다운로드 1개');
ok(/^001_\d{8}_\d{6}\.jpg$/.test(dl[0] || ''), '파일명 규칙 001_날짜_시간.jpg', dl);
if (dl[0]) {
  const jpg = readFileSync(DL + dl[0]);
  ok(jpg[0] === 0xff && jpg[1] === 0xd8, 'JPEG 파일');
}
eq(await text('#listCount'), '1', '목록 배지 1');
ok(!(await ev(`document.getElementById('btnUndo').disabled`)), '되돌리기 활성');
const dims = await ev(`(async () => { const v = document.getElementById('video');
  const r = await new Promise((res) => { const q = indexedDB.open('stampcam'); q.onsuccess = () => {
    const g = q.result.transaction('shots').objectStore('shots').getAll(); g.onsuccess = () => res(g.result); }; });
  const b = await createImageBitmap(r[0].blob); return { img: [b.width, b.height], cam: [v.videoWidth, v.videoHeight], no: r[0].numberText }; })()`);
eq(dims.img, dims.cam, '저장 이미지 해상도 = 카메라 해상도 ' + dims.cam.join('×'));
eq(dims.no, '001', '목록 항목 번호 001');

console.log('\n[3] 되돌리기');
await tap('#btnUndo');
await sleep(500);
eq(await text('#nextText'), '001', '되돌리기 후 다음 번호 001');
ok(await ev(`document.getElementById('listCount').hidden`), '목록에서도 삭제됨');
ok((await text('#toast')).includes('직접 지워'), '다운로드 파일 안내 문구', await text('#toast'));

console.log('\n[4] 설정 변경 → 미리보기 반영 + 저장');
await tap('#btnSettings');
await sleep(300);
ok(await ev(`!document.getElementById('settingsSheet').hidden`), '설정 패널 열림');
await setVal('s-prefix', 'A-');
await setVal('s-current', 7);
await setVal('s-step', 2);
await setVal('s-box', true);
await setVal('s-dateLayout', 'inline');
await setVal('s-color', '#ffcc00');
await tap('#s-position button[data-pos="br"]');
await sleep(300);
eq(await text('#nextText'), 'A-007', '접두어+번호 A-007');
ok((await text('#fileNamePreview')).startsWith('A-007_'), '파일명 미리보기 갱신');
await shot(cdp, OUT + '2-settings.png');
await tap('#settingsSheet [data-close]');
await sleep(300);
await shot(cdp, OUT + '3-preview-br.png');
const saved = await ev(`JSON.parse(localStorage.getItem('stampcam.settings.v1'))`);
eq([saved.prefix, saved.current, saved.step, saved.position, saved.box], ['A-', 7, 2, 'br', true], 'localStorage에 저장됨');

console.log('\n[5] 증감값 2로 연속 촬영');
await tap('#btnShutter');
await waitFor(`document.getElementById('nextText').textContent === 'A-009'`);
await tap('#btnShutter');
ok(await waitFor(`document.getElementById('nextText').textContent === 'A-011'`), '두 장 찍고 다음 번호 A-011');
await sleep(1200);
dl = downloads().sort();
ok(dl.some((f) => f.startsWith('A-007_')) && dl.some((f) => f.startsWith('A-009_')), 'A-007, A-009 다운로드', dl);

console.log('\n[6] 새로고침해도 설정·번호 유지');
await cdp.send('Page.reload');
await sleep(500);
ok(await waitFor(`document.getElementById('video').videoWidth > 0`), '카메라 재시작');
eq(await text('#nextText'), 'A-011', '번호 유지 A-011');
ok(await waitFor(`document.getElementById('listCount').textContent === '2'`), '목록 2장 유지');
ok(await waitFor(`!!document.getElementById('lastThumb').getAttribute('src')`), '마지막 썸네일 표시');

console.log('\n[7] 목록에만 저장 모드 + ZIP 내보내기');
await setVal('s-saveMode', 'list');
const before = downloads().length;
await tap('#btnShutter');
ok(await waitFor(`document.getElementById('nextText').textContent === 'A-013'`), '목록 모드 촬영 → A-013');
await sleep(800);
eq(downloads().length, before, '목록 모드는 다운로드 안 함');
await tap('#btnList');
await sleep(600);
eq(await ev(`document.querySelectorAll('#listGrid .list-item').length`), 3, '목록에 3장');
await shot(cdp, OUT + '4-list.png');
await tap('#btnZip');
await sleep(300);
ok(await waitFor(`document.getElementById('btnZip').textContent === 'ZIP으로 내보내기'`), 'ZIP 생성 완료');
await sleep(1500);
const zips = downloads().filter((f) => f.endsWith('.zip'));
eq(zips.length, 1, 'ZIP 다운로드 1개');
if (zips[0]) console.log('       ZIP:', DL + zips[0], statSync(DL + zips[0]).size + 'B');

console.log('\n[8] 사진 보기 → 삭제');
await tap('#listGrid .list-item');
await sleep(500);
ok(await ev(`!document.getElementById('viewer').hidden && document.getElementById('viewerImg').naturalWidth > 0`), '사진 보기 열림');
await shot(cdp, OUT + '5-viewer.png');
cdp.setDialogAnswer(true);
await tap('#vDelete');
await sleep(600);
eq(await ev(`document.querySelectorAll('#listGrid .list-item').length`), 2, '삭제 후 2장');
await tap('#listSheet [data-close]');

console.log('\n[9] 서비스워커 + 오프라인 실행');
await waitFor(`navigator.serviceWorker.ready.then(() => true)`);
await cdp.send('Page.reload');
await sleep(800);
ok(await waitFor(`!!navigator.serviceWorker.controller`, 6000), '서비스워커가 페이지 제어');
await cdp.send('Network.enable');
await cdp.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
await cdp.send('Page.reload');
await sleep(800);
ok(await waitFor(`document.getElementById('nextText').textContent === 'A-013'`), '오프라인에서도 앱 실행');
await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });

console.log('\n[10] 카메라 권한 거부 → 대체 화면 → 갤러리 사진에 스탬프');
const inj = await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source:
  `navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('denied', 'NotAllowedError'));` });
await cdp.send('Page.reload');
await sleep(500);
ok(await waitFor(`!document.getElementById('camFallback').hidden`), '대체 화면 표시');
ok((await text('#camError')).includes('권한'), '권한 거부 안내 문구');
ok(await ev(`document.getElementById('btnShutter').disabled`), '셔터 비활성');
await shot(cdp, OUT + '6-fallback.png');
await cdp.send('DOM.enable');
const doc = await cdp.send('Runtime.evaluate', { expression: `document.getElementById('fileGallery')` });
const iconA = fileURLToPath(new URL('../icons/icon-512.png', import.meta.url));
await cdp.send('DOM.setFileInputFiles', { files: [iconA, iconA], objectId: doc.result.objectId });
ok(await waitFor(`document.getElementById('nextText').textContent === 'A-017'`), '갤러리 2장 → 번호 A-017');
await sleep(500);
eq(await text('#listCount'), '4', '목록 4장');
await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: inj.identifier });

console.log('\n[11] 콘솔 오류');
const real = errors.filter((e) => !/NotAllowedError|denied|카메라/.test(e));
eq(real, [], '예상 밖 오류 없음');

console.log(`\n결과: ${passes} 통과, ${fails} 실패`);
finish(cdp, fails ? 1 : 0);
