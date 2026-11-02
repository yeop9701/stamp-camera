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

const center = (sel) => ev(`(() => { const el = document.querySelector(${JSON.stringify(sel)});
  el.scrollIntoView({ block: 'nearest' }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
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
ok(await ev(`document.getElementById('btnFlash').disabled`), '플래시 없는 카메라 → 플래시 버튼 비활성');
const geo = await ev(`(() => { const v = document.getElementById('video'), o = document.getElementById('overlay').getBoundingClientRect();
  return { vr: v.videoWidth / v.videoHeight, or: o.width / o.height }; })()`);
ok(Math.abs(geo.or - 4 / 3) < 0.01, '미리보기 스탬프 영역 = 저장될 4:3 영역', geo);
const crops = await ev(`import('./js/camera.js').then((m) => [m.crop43(3840, 2160), m.crop43(1080, 1920), m.crop43(4000, 3000), m.crop43(1920, 1920)])`);
eq(crops, [{ x: 480, y: 0, w: 2880, h: 2160 }, { x: 0, y: 240, w: 1080, h: 1440 }, { x: 0, y: 0, w: 4000, h: 3000 }, { x: 0, y: 240, w: 1920, h: 1440 }],
  '4:3 자르기: 16:9→가운데 4:3, 세로 9:16→3:4, 4:3은 그대로');
await shot(cdp, OUT + '1-start.png');

console.log('\n[2] 촬영 → 자동 다운로드 + 목록 보관, 번호 증가');
await tap('#btnShutter');
ok(await waitFor(`document.getElementById('nextText').textContent === '002'`), '촬영 후 다음 번호 002');
for (let t = 0; t < 80 && !downloads().length; t++) await sleep(100);
let dl = downloads();
eq(dl.length, 1, '다운로드 1개');
ok(/^\d{8}_001\.jpg$/.test(dl[0] || ''), '파일명 규칙 날짜_번호.jpg', dl);
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
const want = dims.cam[0] >= dims.cam[1] ? [Math.round(dims.cam[1] * 4 / 3), dims.cam[1]] : [dims.cam[0], Math.round(dims.cam[0] * 4 / 3)];
eq(dims.img, want, `저장 이미지는 4:3 (카메라 ${dims.cam.join('×')} → ${want.join('×')})`);
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
ok(/^\d{8}_A-007\.jpg$/.test(await text('#fileNamePreview')), '파일명 미리보기 갱신', await text('#fileNamePreview'));
// 칸 내용이 칸보다 넓어 잘리거나(내용 폭 > 칸 폭), 글자가 세로로 쪼개진(한 줄 높이의 2배 넘는 체크박스) 곳
const squeezed = await ev(`[...document.querySelectorAll('#settingsSheet label, #settingsSheet .cell')]
  .filter((l) => !l.closest('[hidden]') && (l.scrollWidth > l.clientWidth + 1 || (l.matches('.check') && l.getBoundingClientRect().height > 48)))
  .map((l) => l.textContent.trim().slice(0, 15))`);
eq(squeezed, [], '설정 항목 중 찌그러진 칸 없음');
for (const w of [320, 390]) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: 844, deviceScaleFactor: 2, mobile: true });
  await sleep(200);
  const over = await ev(`(() => { const b = document.querySelector('#settingsSheet .sheet-body'), lim = b.getBoundingClientRect().right;
    return [...b.querySelectorAll('*')].filter((e) => !e.closest('[hidden]') && e.getBoundingClientRect().right > lim + 0.5)
      .map((e) => e.tagName + ' ' + (e.textContent || '').trim().slice(0, 12)); })()`);
  eq(over, [], `${w}px 화면에서 설정이 옆으로 넘치지 않음`);
}
const twoCol = await ev(`(() => { const r = document.getElementById('s-start').getBoundingClientRect(), q = document.getElementById('s-step').getBoundingClientRect(); return Math.abs(r.top - q.top) < 2; })()`);
ok(twoCol, '보통 글자 크기에서는 두 칸 나란히');
ok(await ev(`document.getElementById('fileNameCustom').hidden`), '파일명: 목록에서 고른 상태면 직접 입력 칸 숨김');
await setVal('fileNamePreset', '{no}_{date}');
ok(/^A-007_\d{8}\.jpg$/.test(await text('#fileNamePreview')), '파일명 "번호_날짜" 선택 반영', await text('#fileNamePreview'));
await setVal('fileNamePreset', '');
ok(!(await ev(`document.getElementById('fileNameCustom').hidden`)), '"직접 입력…" 고르면 입력 칸 표시');
await setVal('s-fileName', '현장1_{날짜}_{번호}');
ok(/^현장1_\d{8}_A-007\.jpg$/.test(await text('#fileNamePreview')), '한글 이름표 {날짜}{번호} 직접 입력 반영', await text('#fileNamePreview'));
await setVal('fileNamePreset', '{date}_{no}');
eq(await ev(`JSON.parse(localStorage.getItem('stampcam.settings.v1')).fileName`), '{date}_{no}', '날짜_번호로 되돌림 저장');
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
ok(dl.some((f) => f.endsWith('_A-007.jpg')) && dl.some((f) => f.endsWith('_A-009.jpg')), 'A-007, A-009 다운로드', dl);

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

console.log('\n[11] 사진에 번호 표시 끄기');
await cdp.send('Page.reload');
await sleep(500);
ok(await waitFor(`document.getElementById('video').videoWidth > 0`), '카메라 재시작');
await setVal('s-box', false);
// 오버레이에 칠해진 픽셀 수 = 스탬프 크기
const inked = () => ev(`(() => { const o = document.getElementById('overlay');
  const d = o.getContext('2d').getImageData(0, 0, o.width, o.height).data; let n = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i]) n++; return n; })()`);
const both = await inked();
await setVal('s-numberOn', false);
const dateOnly = await inked();
ok(dateOnly > 0 && dateOnly < both * 0.8, '번호 끄면 날짜만 남음', { both, dateOnly });
await setVal('s-dateOn', false);
eq(await inked(), 0, '번호·날짜 모두 끄면 스탬프 없음');
await setVal('s-dateOn', true);
await shot(cdp, OUT + '7-date-only.png');
const n0 = await text('#nextText');
await tap('#btnShutter');
ok(await waitFor(`document.getElementById('nextText').textContent !== ${JSON.stringify(n0)}`), '번호 표시를 꺼도 번호는 올라감');
await setVal('s-numberOn', true);
ok((await inked()) > dateOnly, '다시 켜면 번호 표시');

console.log('\n[12] 플래시 (손전등 지원 카메라를 흉내냄)');
const torchMock = await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `
  window.__torch = [];
  const gc = MediaStreamTrack.prototype.getCapabilities;
  MediaStreamTrack.prototype.getCapabilities = function () { return { ...(gc ? gc.call(this) : {}), torch: true }; };
  MediaStreamTrack.prototype.applyConstraints = function (c) {
    const t = c && c.advanced && c.advanced[0] && 'torch' in c.advanced[0];
    if (t) window.__torch.push({ on: c.advanced[0].torch, at: performance.now() });
    return Promise.resolve();
  };` });
await cdp.send('Page.reload');
await sleep(500);
ok(await waitFor(`document.getElementById('video').videoWidth > 0 && !document.getElementById('btnFlash').disabled`), '플래시 버튼 활성');
eq(await text('#flashLabel'), '끔', '처음엔 끔');
await tap('#btnFlash');
await sleep(200);
eq(await text('#flashLabel'), '촬영', '한 번 누르면 "촬영" 모드');
await ev(`(window.__torch.length = 0, true)`);
const nA = await text('#nextText');
const t0 = await ev('performance.now()');
await tap('#btnShutter');
ok(await waitFor(`document.getElementById('nextText').textContent !== ${JSON.stringify(nA)}`), '플래시 촬영 저장됨');
await sleep(300);
const log = await ev('window.__torch');
eq(log.map((l) => l.on), [true, false], '찍을 때 켰다가 끔');
ok(log.length === 2 && log[1].at - log[0].at >= 650, '켠 뒤 노출 맞출 시간(0.7초) 기다림', log.map((l) => Math.round(l.at - t0)));
await tap('#btnFlash');
await sleep(200);
eq(await text('#flashLabel'), '켜짐', '두 번 누르면 "켜짐" 모드');
eq((await ev('window.__torch')).slice(-1)[0].on, true, '켜짐 모드 → 손전등 켜짐');
await cdp.send('Page.reload');
await sleep(500);
ok(await waitFor(`window.__torch.length > 0 && window.__torch.slice(-1)[0].on === true`), '새로고침 후에도 켜짐 모드 유지');
await tap('#btnFlash');
await sleep(200);
eq(await text('#flashLabel'), '끔', '세 번째 누르면 끔');
eq((await ev('window.__torch')).slice(-1)[0].on, false, '손전등 꺼짐');
await shot(cdp, OUT + '8-flash.png');
await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: torchMock.identifier });

console.log('\n[13] 예전 파일명 기본값은 새 기본값으로 옮김');
await ev(`(() => { const s = JSON.parse(localStorage.getItem('stampcam.settings.v1')); s.fileName = '{no}_{date}_{time}';
  localStorage.setItem('stampcam.settings.v1', JSON.stringify(s)); return true; })()`);
await cdp.send('Page.reload');
await sleep(800);
eq(await ev(`document.getElementById('s-fileName').value`), '{date}_{no}', '옛 기본값 → {date}_{no}');
await setVal('s-fileName', '{no}');
await cdp.send('Page.reload');
await sleep(800);
eq(await ev(`document.getElementById('s-fileName').value`), '{no}', '직접 바꾼 규칙은 그대로');

console.log('\n[14] 콘솔 오류');
const real = errors.filter((e) => !/NotAllowedError|denied|카메라/.test(e));
eq(real, [], '예상 밖 오류 없음');

console.log(`\n결과: ${passes} 통과, ${fails} 실패`);
finish(cdp, fails ? 1 : 0);
