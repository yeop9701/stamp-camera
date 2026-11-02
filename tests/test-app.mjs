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
const begun = []; // 다운로드 시작 이름 (같은 이름 파일은 덮어써져 폴더 개수로는 못 셈)
cdp.ws.addEventListener('message', (m) => {
  const d = JSON.parse(m.data);
  if (d.method === 'Browser.downloadWillBegin') begun.push(d.params.suggestedFilename);
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
eq(await text('#nextText'), '0001', '다음 번호 0001 (기본 4자리)');
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
eq(await ev(`[document.getElementById('s-numberOn').checked, document.getElementById('s-dateOn').checked]`), [false, false],
  '기본값: 사진에 번호·날짜 표시 꺼짐');
eq(await ev(`(() => { const o = document.getElementById('overlay'); const d = o.getContext('2d').getImageData(0, 0, o.width, o.height).data;
  let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i]) n++; return n; })()`), 0, '기본값에서는 미리보기에 스탬프 없음');
await setVal('s-numberOn', true);
await setVal('s-dateOn', true);

console.log('\n[2] 촬영 → 자동 다운로드 + 목록 보관, 번호 증가');
await tap('#btnShutter');
ok(await waitFor(`document.getElementById('nextText').textContent === '0002'`), '촬영 후 다음 번호 0002');
for (let t = 0; t < 80 && !downloads().length; t++) await sleep(100);
let dl = downloads();
eq(dl.length, 1, '다운로드 1개');
ok(/^\d{8}_0001\.jpg$/.test(dl[0] || ''), '파일명 규칙 날짜_번호.jpg', dl);
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
eq(dims.no, '0001', '목록 항목 번호 0001');
ok((await text('#lastSavedInfo')).startsWith(`최근 저장: ${want.join('×')}`), '설정에 최근 저장 크기·용량 표시', await text('#lastSavedInfo'));
const resOff = await text('#resInfo');
await setVal('s-hiRes', true);
ok(await waitFor(`!document.getElementById('resInfo').textContent.includes('확인 중')`), '고화질 해상도 확인 끝남');
const resOn = await text('#resInfo');
ok(resOn !== resOff && /고화질/.test(resOn), '고화질 켜면 해상도 안내가 바뀜', { resOff, resOn });
const nHi = await text('#nextText');
await tap('#btnShutter');
ok(await waitFor(`document.getElementById('nextText').textContent !== ${JSON.stringify(nHi)}`), '고화질 켠 채 촬영');
await sleep(300);
const hiDims = (await text('#lastSavedInfo')).match(/(\d+)×(\d+)/);
ok(hiDims && hiDims[1] * hiDims[2] >= want[0] * want[1], '고화질이 더 작은 기기에서도 작게 찍히지 않음', await text('#lastSavedInfo'));
await tap('#btnUndo'); // 이 검사용 사진은 되돌려 뒤 검사 번호를 맞춘다
await sleep(500);
console.log('       끔:', resOff, '\n       켬:', resOn);
await setVal('s-hiRes', false);
eq(await text('#resInfo'), resOff, '고화질 끄면 원래대로');

console.log('\n[3] 되돌리기');
await tap('#btnUndo');
await sleep(500);
eq(await text('#nextText'), '0001', '되돌리기 후 다음 번호 0001');
ok(await ev(`document.getElementById('listCount').hidden`), '목록에서도 삭제됨');
ok((await text('#toast')).includes('직접 지워'), '다운로드 파일 안내 문구', await text('#toast'));

console.log('\n[4] 설정 변경 → 미리보기 반영 + 저장');
await tap('#btnSettings');
await sleep(300);
ok(await ev(`!document.getElementById('settingsSheet').hidden`), '설정 패널 열림');
await setVal('s-prefix', 'A-');
await setVal('s-pad', '3');
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
await setVal('fileNamePreset', '{no}_{memo}_{date}');
ok(/^A-007_\d{8}\.jpg$/.test(await text('#fileNamePreview')), '파일명 "번호_날짜" 선택 반영', await text('#fileNamePreview'));
await setVal('fileNamePreset', '');
ok(!(await ev(`document.getElementById('fileNameCustom').hidden`)), '"직접 입력…" 고르면 입력 칸 표시');
await setVal('s-fileName', '현장1_{날짜}_{번호}');
ok(/^현장1_\d{8}_A-007\.jpg$/.test(await text('#fileNamePreview')), '한글 이름표 {날짜}{번호} 직접 입력 반영', await text('#fileNamePreview'));
await setVal('fileNamePreset', '{date}_{no}_{memo}');
eq(await ev(`JSON.parse(localStorage.getItem('stampcam.settings.v1')).fileName`), '{date}_{no}_{memo}', '날짜_번호_메모로 되돌림 저장');
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
ok(await waitFor(`document.getElementById('btnZip').textContent === '전체 ZIP'`), 'ZIP 생성 완료');
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

console.log('\n[8-2] 목록에서 여러 장 선택 → ZIP / 다운로드 / 삭제');
const vis = (id) => ev(`!document.getElementById(${JSON.stringify(id)}).hidden`);
ok(await vis('listTip'), '길게 누르기 안내 표시');
await tap('#btnSelect');
await sleep(200);
ok((await vis('selBar')) && !(await vis('listActions')), '선택 모드: 선택 막대로 바뀜');
ok(await ev(`['selDownload','selZip','selShare','selDelete'].every((k) => document.getElementById(k).disabled)`), '아무것도 안 고르면 버튼 비활성');
await tap('#listGrid .list-item');
await sleep(200);
eq(await text('#selCount'), '1장 선택', '사진 누르면 선택 (1장)');
ok(!(await vis('viewer')), '선택 모드에서는 사진 보기가 안 열림');
eq(await ev(`document.querySelectorAll('#listGrid .list-item.sel').length`), 1, '고른 사진 표시');
await shot(cdp, OUT + '5b-select.png');
await tap('#selAll');
await sleep(200);
eq([await text('#selCount'), await text('#selAll')], ['2장 선택', '선택 해제'], '전체 선택');
const zipsBefore = downloads().filter((f) => f.endsWith('.zip')).length;
await tap('#selZip');
for (let t = 0; t < 50 && downloads().filter((f) => f.endsWith('.zip')).length === zipsBefore; t++) await sleep(100);
eq(downloads().filter((f) => f.endsWith('.zip')).length, zipsBefore + 1, '선택한 사진 ZIP 다운로드');
const begunBefore = begun.length;
await tap('#selDownload');
for (let t = 0; t < 50 && begun.length < begunBefore + 2; t++) await sleep(100);
const got = begun.slice(begunBefore);
ok(got.length === 2 && got.every((n) => n.endsWith('.jpg')), '선택한 2장을 낱장 JPG로 다운로드', got);
await tap('#selCancel');
await sleep(200);
ok((await vis('listActions')) && (await ev(`document.querySelectorAll('#listGrid .list-item.sel').length`)) === 0, '취소하면 선택 풀림');
// 길게 누르기 (터치)
const lp = await center('#listGrid .list-item:last-child');
await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: lp.x, y: lp.y }] });
await sleep(800);
await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
await sleep(300);
ok(await vis('selBar'), '길게 누르면 선택 모드');
eq(await text('#selCount'), '1장 선택', '길게 누른 사진이 선택됨');
ok(!(await vis('viewer')), '길게 누른 뒤 사진 보기가 안 열림');
cdp.setDialogAnswer(true);
await tap('#selDelete');
await sleep(600);
eq(await ev(`document.querySelectorAll('#listGrid .list-item').length`), 1, '선택 삭제 후 1장');
ok(!(await vis('selBar')), '삭제 후 선택 모드 끝남');
eq(await text('#listCount'), '1', '배지도 1');
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
eq(await text('#listCount'), '3', '목록 3장');
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
eq(await ev(`document.getElementById('s-fileName').value`), '{date}_{no}_{memo}', '옛 기본값 → {date}_{no}_{memo}');
await setVal('s-fileName', '{no}');
await cdp.send('Page.reload');
await sleep(800);
eq(await ev(`document.getElementById('s-fileName').value`), '{no}', '직접 바꾼 규칙은 그대로');

console.log('\n[13-2] 예전 판(사진에 표시 켜짐 기본값) 설정은 한 번 꺼 줌');
const setStored = (patch) => ev(`(() => { const s = JSON.parse(localStorage.getItem('stampcam.settings.v1'));
  const p = ${JSON.stringify(patch)}; for (const k in p) { if (p[k] === null) delete s[k]; else s[k] = p[k]; }
  localStorage.setItem('stampcam.settings.v1', JSON.stringify(s)); return true; })()`);
const shown = () => ev(`[document.getElementById('s-numberOn').checked, document.getElementById('s-dateOn').checked]`);
await setStored({ rev: null, numberOn: true, dateOn: true });
await cdp.send('Page.reload');
await sleep(800);
eq(await shown(), [false, false], '예전 판 → 꺼짐으로 옮김');
await setVal('s-numberOn', true);
await cdp.send('Page.reload');
await sleep(800);
eq(await shown(), [true, false], '옮긴 뒤 다시 켠 것은 그대로');

console.log('\n[13-2b] 자릿수 기본값 3 → 4 (rev 3)');
const padVal = () => ev(`document.getElementById('s-pad').value`);
await setStored({ rev: 2, pad: 3 });
await cdp.send('Page.reload');
await sleep(800);
eq(await padVal(), '4', '옛 기본값 3자리 → 4자리로 옮김');
await setStored({ rev: 2, pad: 2 });
await cdp.send('Page.reload');
await sleep(800);
eq(await padVal(), '2', '직접 고른 2자리는 그대로');
await setVal('s-pad', '3');
await cdp.send('Page.reload');
await sleep(800);
eq(await padVal(), '3', '옮긴 뒤 다시 고른 3자리는 그대로');

console.log('\n[13-3] 가로 화면');
eq(await ev(`fetch('manifest.webmanifest').then((r) => r.json()).then((m) => m.orientation)`), 'any', '앱 설치 시 화면 방향 고정 안 함');
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 844, height: 390, deviceScaleFactor: 2, mobile: true,
  screenOrientation: { type: 'landscapePrimary', angle: 90 } });
await sleep(600);
const land = await ev(`(() => { const r = (id) => document.querySelector(id).getBoundingClientRect();
  const t = r('.topbar'), st = r('#stage'), b = r('.bottombar'), sh = r('#btnShutter');
  return { side: t.right <= st.left + 1 && st.right <= b.left + 1, stage: [Math.round(st.width), Math.round(st.height)],
    shutterIn: sh.top >= 0 && sh.bottom <= innerHeight, noScroll: document.documentElement.scrollWidth <= innerWidth }; })()`);
ok(land.side, '설정·번호 막대는 왼쪽, 셔터 막대는 오른쪽', land);
ok(land.stage[1] >= 380 && land.stage[0] > land.stage[1], '미리보기가 화면 높이 전체를 씀', land.stage);
ok(land.shutterIn && land.noScroll, '셔터가 화면 안에 있고 옆 스크롤 없음', land);
await shot(cdp, OUT + '9-landscape.png');
const nL = await text('#nextText');
await tap('#btnShutter');
ok(await waitFor(`document.getElementById('nextText').textContent !== ${JSON.stringify(nL)}`), '가로 화면에서 촬영');
await sleep(300);
const ld = (await text('#lastSavedInfo')).match(/(\d+)×(\d+)/);
ok(ld && Math.abs(ld[1] / ld[2] - 4 / 3) < 0.01, '가로 사진 4:3', ld && ld[0]);
await tap('#btnSettings');
await sleep(400);
ok(await ev(`(() => { const b = document.querySelector('#settingsSheet .sheet-body'); const r = document.getElementById('settingsSheet').getBoundingClientRect();
  return b.scrollWidth <= b.clientWidth && r.top >= 0 && r.bottom <= innerHeight + 1; })()`), '가로 화면 설정창: 화면 안, 옆 스크롤 없음');
await shot(cdp, OUT + '9b-landscape-settings.png');
await tap('#settingsSheet [data-close]');
// 큰 화면(태블릿·폴드 펼침) 가로에서도 셔터는 오른쪽 (v1.5.0은 높이 600px 넘으면 아래로 갔음)
for (const [w, h] of [[1280, 800], [1024, 768], [2208, 1768]]) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: true,
    screenOrientation: { type: 'landscapePrimary', angle: 90 } });
  await sleep(400);
  const big = await ev(`(() => { const r = (id) => document.querySelector(id).getBoundingClientRect();
    const t = r('.topbar'), st = r('#stage'), b = r('.bottombar');
    return { side: t.right <= st.left + 1 && st.right <= b.left + 1, stageH: Math.round(st.height) }; })()`);
  ok(big.side && big.stageH >= h - 1, `가로 ${w}×${h}: 셔터 오른쪽, 미리보기 높이 전체`, big);
  if (w === 1280) await shot(cdp, OUT + '9c-landscape-tablet.png');
}
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });

console.log('\n[15] 같은 번호로 여러 장');
await setVal('s-saveMode', 'list');
await setVal('fileNamePreset', '{date}_{no}_{memo}');
await setVal('s-prefix', '');
await setVal('s-pad', '4');
await setVal('s-step', 1);
await setVal('s-current', 30);
const latestShots = (n) => ev(`import('./js/storage.js').then((m) => m.listShots()).then((a) => a.slice(0, ${n}).map((i) => [i.numberText, i.name, i.memo || '']).reverse())`);
const shoot1 = async () => {
  const before = await text('#nextText');
  await tap('#btnShutter');
  return waitFor(`document.getElementById('nextText').textContent !== ${JSON.stringify(before)}`);
};
eq(await ev(`document.getElementById('btnSame').getAttribute('aria-pressed')`), 'false', '같은 번호 기본은 꺼짐');
await shoot1();
eq(await text('#nextText'), '0031', '보통 촬영 0030 → 다음 0031');
await tap('#btnSame');
await sleep(200);
eq(await text('#nextText'), '0030-2', '방금 찍은 0030에 이어서 0030-2');
eq(await ev(`document.getElementById('btnSame').getAttribute('aria-pressed')`), 'true', '버튼 켜짐 표시');
ok(await shoot1() && await shoot1(), '같은 번호로 두 장');
eq(await text('#nextText'), '0030-4', '다음은 0030-4');
await tap('#btnUndo');
await sleep(300);
eq(await text('#nextText'), '0030-3', '되돌리기 → 0030-3');
await tap('#btnSame');
await sleep(200);
eq(await text('#nextText'), '0031', '끄면 다음 번호 0031');
const names3 = (await latestShots(2)).map((r) => r[0]);
eq(names3, ['0030', '0030-2'], '저장된 번호 0030, 0030-2 (되돌린 0030-3 은 지워짐)');
await tap('#btnSame');
await sleep(200);
eq(await text('#nextText'), '0031-1', '이어갈 사진이 없으면 -1부터');
await tap('#btnSame');
await sleep(200);
eq(await text('#nextText'), '0031', '한 장도 안 찍고 끄면 번호 그대로');
await setVal('s-subSep', '_');
await tap('#btnSame');
await sleep(200);
eq(await text('#nextText'), '0031_1', '뒤 번호 기호 _ 선택 반영');
await tap('#btnSame');
await setVal('s-subSep', '-');

console.log('\n[16] 메모');
eq(await text('#memoText'), '없음', '처음엔 메모 없음');
await tap('#btnMemo');
await sleep(300);
ok(await ev(`!document.getElementById('memoSheet').hidden`), '메모 창 열림');
await setVal('memoInput', '3층 C2 기둥');
await ev(`document.getElementById('memoForm').requestSubmit(), true`);
await sleep(300);
ok(await ev(`document.getElementById('memoSheet').hidden`), '확인 누르면 닫힘');
eq(await text('#memoText'), '3층 C2 기둥', '촬영 화면에 메모 표시');
ok(/^\d{8}_0031_3층 C2 기둥\.jpg$/.test(await text('#fileNamePreview')), '파일명 미리보기에 메모', await text('#fileNamePreview'));
await shoot1();
await sleep(300);
const m1 = (await latestShots(1))[0];
ok(m1[0] === '0031' && /_0031_3층 C2 기둥\.jpg$/.test(m1[1]) && m1[2] === '3층 C2 기둥', '저장 파일명·목록에 메모', m1);
await tap('#btnMemo');
await sleep(300);
await setVal('memoInput', '지하1층 보');
await ev(`document.getElementById('memoForm').requestSubmit(), true`);
await sleep(200);
await tap('#btnMemo');
await sleep(300);
eq(await ev(`[...document.querySelectorAll('#memoRecent .chip button:not(.x)')].map((b) => b.textContent)`), ['지하1층 보', '3층 C2 기둥'], '최근 메모 목록 (최근 것이 앞)');
await shot(cdp, OUT + '10-memo.png');
await tap('#memoRecent .chip:nth-child(2) button:not(.x)');
await sleep(200);
eq(await text('#memoText'), '3층 C2 기둥', '최근 메모 눌러 고르기');
await tap('#btnMemo');
await sleep(300);
await tap('#memoNone');
await sleep(200);
eq(await text('#memoText'), '없음', '메모 없이 찍기');
ok(/^\d{8}_0032\.jpg$/.test(await text('#fileNamePreview')), '메모가 없으면 파일명에서 빠짐', await text('#fileNamePreview'));
const memoPx = await ev(`import('./js/stamp.js').then(({ drawStamp }) => {
  const count = (texts) => { const c = document.createElement('canvas'); c.width = 800; c.height = 600; const x = c.getContext('2d');
    drawStamp(x, 800, 600, texts, { size: 8, margin: 3, bold: true, color: '#ffffff', outline: false, box: false, position: 'tl', dateLayout: 'below' });
    const d = x.getImageData(0, 0, 800, 600).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i]) n++; return n; };
  return [count({ numberText: '0012', memoText: '', dateText: '' }), count({ numberText: '0012', memoText: '3층 C2 기둥', dateText: '' })]; })`);
ok(memoPx[1] > memoPx[0] * 1.3, '사진에 표시를 켜면 메모 줄이 찍힘', memoPx);
await setVal('s-memoOn', true);
eq(await ev(`JSON.parse(localStorage.getItem('stampcam.settings.v1')).memoOn`), true, '메모 사진에 표시 저장');
await setVal('s-memoOn', false);

console.log('\n[17] 줌 (디지털)');
const fmtZ = (z) => (Math.abs(z - Math.round(z)) < 0.05 ? String(Math.round(z)) : z.toFixed(1)) + '×';
eq(await ev(`[...document.querySelectorAll('#zoomBar button')].map((b) => b.dataset.z)`), ['1', '2', '4'], '가짜 카메라는 줌 미지원 → 디지털 1·2·4배');
const dim0 = (await text('#resInfo')).match(/(\d+)×(\d+)/)[0];
await tap('#zoomBar button[data-z="2"]');
await sleep(200);
eq(await ev(`getComputedStyle(document.getElementById('stage')).getPropertyValue('--dz').trim()`), '2', '2배: 미리보기 확대');
await shoot1();
await sleep(300);
const zd = (await text('#lastSavedInfo')).match(/(\d+)×(\d+)/);
eq(zd && zd[0], dim0, '디지털 줌 사진도 같은 해상도로 저장');
// 두 손가락 벌리기
const st = await ev(`(() => { const r = document.getElementById('stage').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
await tap('#zoomBar button[data-z="1"]');
const touch = (type, d) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x: st.x - d, y: st.y, id: 1 }, { x: st.x + d, y: st.y, id: 2 }] });
await touch('touchStart', 40);
for (const d of [60, 80, 100, 120]) await touch('touchMove', d);
await touch('touchEnd', 0);
await sleep(200);
const zPinch = Number(await ev(`getComputedStyle(document.getElementById('stage')).getPropertyValue('--dz')`));
ok(zPinch > 2.5 && zPinch <= 3.05, '두 손가락으로 벌리면 약 3배', zPinch);
eq(await ev(`document.querySelector('#zoomBar button.on').textContent`), fmtZ(zPinch), '켜진 버튼에 지금 배율 표시');
await tap('#zoomBar button[data-z="1"]');

console.log('\n[18] 카메라 줌 · 눌러서 초점 (지원 기기 흉내)');
const camMock = await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `
  window.__cons = [];
  const gc0 = MediaStreamTrack.prototype.getCapabilities;
  MediaStreamTrack.prototype.getCapabilities = function () {
    return { ...(gc0 ? gc0.call(this) : {}), zoom: { min: 1, max: 8, step: 0.1 }, focusMode: ['continuous', 'single-shot', 'manual'], exposureMode: ['continuous'] };
  };
  MediaStreamTrack.prototype.applyConstraints = function (c) { window.__cons.push(JSON.parse(JSON.stringify(c.advanced[0]))); return Promise.resolve(); };
` });
await cdp.send('Page.reload');
ok(await waitFor(`document.getElementById('video').videoWidth > 0 && document.querySelectorAll('#zoomBar button').length > 0`), '다시 열림');
eq(await ev(`[...document.querySelectorAll('#zoomBar button')].map((b) => b.dataset.z)`), ['1', '2', '4'], '카메라 줌 1~8배 → 1·2·4 (10배는 없음)');
await ev(`(window.__cons.length = 0, true)`);
await tap('#zoomBar button[data-z="4"]');
await sleep(300);
ok((await ev('window.__cons')).some((c) => c.zoom === 4), '카메라에 줌 4 요청', await ev('window.__cons'));
eq(await ev(`getComputedStyle(document.getElementById('stage')).getPropertyValue('--dz').trim()`), '1', '카메라 줌일 때는 화면 확대 안 함');
await ev(`(window.__cons.length = 0, true)`);
const ov = await ev(`(() => { const r = document.getElementById('overlay').getBoundingClientRect(); return { x: r.x + r.width * 0.25, y: r.y + r.height * 0.75 }; })()`);
await click(cdp, ov.x, ov.y);
await sleep(300);
const fc = (await ev('window.__cons')).find((c) => c.pointsOfInterest);
ok(fc && fc.focusMode === 'single-shot' && Math.abs(fc.pointsOfInterest[0].x - 0.3) < 0.05 && Math.abs(fc.pointsOfInterest[0].y - 0.75) < 0.05,
  '누른 자리(왼쪽 아래)로 초점 요청', fc);
ok(await waitFor(`window.__cons.some((c) => c.focusMode === 'continuous' && !c.pointsOfInterest)`, 8000), '잠시 뒤 연속 자동 초점으로 돌아감');
await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: camMock.identifier });
await cdp.send('Page.reload');
ok(await waitFor(`document.getElementById('video').videoWidth > 0`), '흉내 끄고 다시 열림');
await sleep(300);
await click(cdp, ov.x, ov.y);
await sleep(300);
ok(await ev(`!document.getElementById('focusRing').classList.contains('fail')`), '가짜 카메라(연속 초점만 지원)도 누른 자리 초점 요청');
await ev(`(MediaStreamTrack.prototype.getCapabilities = function () { return {}; }, true)`);
await sleep(700);
await click(cdp, ov.x, ov.y);
ok(await waitFor(`document.getElementById('toast').textContent.includes('초점')`, 2000), '초점 미지원 기기는 한 번 알려 줌');
await cdp.send('Page.reload');
ok(await waitFor(`document.getElementById('video').videoWidth > 0`), '다시 열림');

console.log('\n[19] 격자선 · 수평 표시');
eq(await ev(`[JSON.parse(localStorage.getItem('stampcam.settings.v1')).gridOn, JSON.parse(localStorage.getItem('stampcam.settings.v1')).levelOn, document.getElementById('guides').hidden]`),
  [false, false, true], '기본은 둘 다 꺼짐');
await setVal('s-gridOn', true);
await sleep(100);
ok(await ev(`!document.getElementById('guides').hidden && document.getElementById('guides').classList.contains('grid')`), '격자선 켜기');
const gr = await ev(`(() => { const a = document.getElementById('guides').getBoundingClientRect(), b = document.getElementById('overlay').getBoundingClientRect(); return Math.abs(a.x - b.x) + Math.abs(a.width - b.width) + Math.abs(a.height - b.height); })()`);
ok(gr < 2, '격자선은 저장될 4:3 영역에 맞춤', gr);
await setVal('s-levelOn', true);
const motion = (x, y, z) => ev(`(window.dispatchEvent(new DeviceMotionEvent('devicemotion', { accelerationIncludingGravity: { x: ${x}, y: ${y}, z: ${z} } })), new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))).then(() => true))`);
await motion(0, 9.8, 0);
eq(await ev(`[document.getElementById('levelLine').hidden, document.getElementById('levelLine').dataset.roll, document.getElementById('levelLine').classList.contains('ok')]`),
  [false, '0.0', true], '세워서 수평: 선 표시, 노란색');
await motion(-1.7, 9.65, 0);
const roll = Number(await ev(`document.getElementById('levelLine').dataset.roll`));
ok(Math.abs(roll + 10) < 0.5 && !(await ev(`document.getElementById('levelLine').classList.contains('ok')`)), '오른쪽으로 10° 기울면 선이 반대로 10° (흰색)', roll);
await shot(cdp, OUT + '11-grid-level.png');
await motion(0.5, 0.3, 9.8);
eq(await ev(`[document.getElementById('levelLine').hidden, document.getElementById('levelBubble').hidden]`), [true, false], '눕혀 들면 기포 표시');
await motion(0, 0, 9.8);
ok(await ev(`document.getElementById('levelBubble').classList.contains('ok')`), '평평하면 기포 노란색');
await setVal('s-gridOn', false);
await setVal('s-levelOn', false);
await sleep(100);
ok(await ev(`document.getElementById('guides').hidden`), '둘 다 끄면 숨김');

console.log('\n[20] 목록 CSV · ZIP 안 목록');
await tap('#btnList');
await sleep(600);
const csvBefore = downloads().filter((f) => f.endsWith('.csv')).length;
await tap('#btnCsv');
for (let t = 0; t < 50 && downloads().filter((f) => f.endsWith('.csv')).length === csvBefore; t++) await sleep(100);
const csvs = downloads().filter((f) => f.endsWith('.csv'));
ok(csvs.length === csvBefore + 1, 'CSV 다운로드', csvs);
if (csvs.length) {
  const raw = readFileSync(DL + csvs[csvs.length - 1]);
  const body = raw.toString('utf8');
  ok(raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf, '엑셀 한글용 BOM');
  ok(body.includes('순서,번호,메모,촬영일,촬영시각,파일명,가로,세로'), 'CSV 머리줄');
  ok(body.includes(',0031,3층 C2 기둥,') && body.includes(',0030-2,,'), '번호·메모가 들어감');
}
const zipBefore = downloads().filter((f) => f.endsWith('.zip')).length;
await tap('#btnZip');
for (let t = 0; t < 80 && downloads().filter((f) => f.endsWith('.zip')).length === zipBefore; t++) await sleep(100);
const zipsNow = downloads().filter((f) => f.endsWith('.zip')).sort((a, b) => statSync(DL + b).mtimeMs - statSync(DL + a).mtimeMs);
ok(zipsNow[0] && readFileSync(DL + zipsNow[0]).includes(Buffer.from('목록.csv')), 'ZIP 안에 목록.csv', zipsNow[0]);
await tap('#listSheet [data-close]');

console.log('\n[21] 예전 판 파일명 규칙 → 메모 들어간 규칙');
await setStored({ rev: 3, fileName: '{no}_{date}' });
await cdp.send('Page.reload');
await sleep(800);
eq(await ev(`document.getElementById('s-fileName').value`), '{no}_{memo}_{date}', '번호_날짜 → 번호_메모_날짜');
await setStored({ rev: 3, fileName: '현장_{no}' });
await cdp.send('Page.reload');
await sleep(800);
eq(await ev(`document.getElementById('s-fileName').value`), '현장_{no}', '직접 쓴 규칙은 그대로');
await setVal('fileNamePreset', '{date}_{no}_{memo}');

console.log('\n[22] 좁은 화면 · 가로 화면 배치');
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 320, height: 640, deviceScaleFactor: 2, mobile: true });
await sleep(300);
const narrow = await ev(`(() => { const n = document.getElementById('btnNext').getBoundingClientRect(), t = document.querySelector('.topbar');
  return { nextW: Math.round(n.width), fits: t.scrollWidth <= t.clientWidth + 1, noScroll: document.documentElement.scrollWidth <= innerWidth }; })()`);
ok(narrow.nextW >= 90 && narrow.fits && narrow.noScroll, '320px 화면: 위 막대가 넘치지 않음', narrow);
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 844, height: 390, deviceScaleFactor: 2, mobile: true,
  screenOrientation: { type: 'landscapePrimary', angle: 90 } });
await sleep(500);
const lay = await ev(`(() => { const r = (s) => document.querySelector(s).getBoundingClientRect(); const st = r('#stage'), m = r('#btnMemo'), z = r('#zoomBar'), t = r('.topbar');
  return { memoIn: m.left >= st.left && m.right <= st.right && m.top >= st.top, zoomIn: z.bottom <= st.bottom && z.left >= st.left,
    apart: m.bottom < z.top, barsFit: document.querySelector('.topbar').scrollHeight <= innerHeight + 1 }; })()`);
ok(lay.memoIn && lay.zoomIn && lay.apart && lay.barsFit, '가로: 메모·줌이 미리보기 안, 막대가 화면 안', lay);
await shot(cdp, OUT + '12-landscape-new.png');
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await sleep(300);
await shot(cdp, OUT + '13-portrait-new.png');

console.log('\n[14] 콘솔 오류');
const real = errors.filter((e) => !/NotAllowedError|denied|카메라/.test(e));
eq(real, [], '예상 밖 오류 없음');

console.log(`\n결과: ${passes} 통과, ${fails} 실패`);
finish(cdp, fails ? 1 : 0);
