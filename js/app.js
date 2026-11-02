// 전체 연결과 UI 이벤트.
import { loadSettings, saveSettings, DEFAULTS } from './settings.js';
import { formatNumber, nextValue, formatDate, buildFileName, DATE_FORMATS } from './counter.js';
import { drawStamp } from './stamp.js';
import { Camera, cameraErrorMessage } from './camera.js';
import { addShot, deleteShot, clearShots, getShot, listShots, allShotsWithBlobs, requestPersist } from './storage.js';
import { downloadBlob, shareBlob, canvasToBlob } from './save.js';
import { makeZip, uniqueNames } from './zip.js';

const APP_VERSION = '1.1.0';
const $ = (id) => document.getElementById(id);

let s = loadSettings();
const camera = new Camera($('video'));
const undoStack = []; // { number, listId, numberText }
let busy = false;
let lastThumbUrl = null;

/* ── 공통 ───────────────────────────────────────── */
let toastTimer;
function toast(msg, ms = 1800) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

function persist() {
  if (!saveSettings(s)) toast('설정을 저장하지 못했습니다 (저장 공간 문제).');
}

function currentTexts(date) {
  return {
    numberText: s.numberOn ? formatNumber(s.current, s) : '',
    dateText: s.dateOn ? formatDate(date, s.dateFormat) : '',
  };
}

/* ── 플래시 ─────────────────────────────────────── */
const FLASH_SETTLE_MS = 700;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FLASH_LABEL ={ off: '끔', shot: '촬영', on: '켜짐' };
const FLASH_HINT = { off: '플래시 끔', shot: '플래시: 찍는 순간에만 켜짐', on: '플래시: 계속 켜짐' };

function updateFlashUI() {
  const b = $('btnFlash');
  const ok = camera.active && camera.torchSupported;
  b.disabled = !ok;
  b.dataset.mode = ok ? s.flashMode : 'off';
  $('flashLabel').textContent = ok ? FLASH_LABEL[s.flashMode] : '';
  b.setAttribute('aria-label', ok ? FLASH_HINT[s.flashMode] : '이 카메라는 플래시를 지원하지 않음');
}

// 카메라를 켜거나 바꾼 뒤, 현재 모드에 맞게 손전등을 켜고 끈다
async function applyFlash() {
  if (camera.active && camera.torchSupported) await camera.setTorch(s.flashMode === 'on');
  updateFlashUI();
}

function updateNext() {
  $('nextText').textContent = formatNumber(s.current, s);
  $('btnUndo').disabled = undoStack.length === 0;
  $('fileNamePreview').textContent = buildFileName(s.fileName, formatNumber(s.current, s), new Date());
}

/* ── 미리보기 오버레이 ───────────────────────────── */
function renderOverlay() {
  const ov = $('overlay');
  const v = $('video');
  if (!camera.active || !v.videoWidth) {
    ov.hidden = true;
    return;
  }
  ov.hidden = false;
  const stage = $('stage').getBoundingClientRect();
  // object-fit: contain 으로 그려진 실제 영상 영역
  const scale = Math.min(stage.width / v.videoWidth, stage.height / v.videoHeight);
  const w = v.videoWidth * scale;
  const h = v.videoHeight * scale;
  const dpr = window.devicePixelRatio || 1;
  ov.style.width = w + 'px';
  ov.style.height = h + 'px';
  ov.style.left = (stage.width - w) / 2 + 'px';
  ov.style.top = (stage.height - h) / 2 + 'px';
  const pw = Math.round(w * dpr);
  const ph = Math.round(h * dpr);
  if (ov.width !== pw) ov.width = pw;
  if (ov.height !== ph) ov.height = ph;
  const ctx = ov.getContext('2d');
  ctx.clearRect(0, 0, pw, ph);
  drawStamp(ctx, pw, ph, currentTexts(new Date()), s);
}

// 시간 표시가 있으면 1초마다 다시 그린다
setInterval(() => {
  if (s.dateOn && camera.active && !document.hidden) renderOverlay();
}, 1000);
window.addEventListener('resize', renderOverlay);
$('video').addEventListener('loadedmetadata', renderOverlay);
$('video').addEventListener('resize', renderOverlay);

/* ── 카메라 ─────────────────────────────────────── */
async function startCamera() {
  $('camFallback').hidden = true;
  try {
    await camera.start(s.facing);
    $('btnShutter').disabled = false;
    $('btnSwitch').disabled = false;
    updateResInfo();
    renderOverlay();
    await applyFlash();
  } catch (e) {
    console.error(e);
    showFallback(cameraErrorMessage(e));
  }
}

function updateResInfo() {
  const v = $('video');
  if (!v.videoWidth) return ($('resInfo').textContent = '');
  const mp = ((v.videoWidth * v.videoHeight) / 1e6).toFixed(1);
  $('resInfo').textContent = `지금 저장 해상도: ${v.videoWidth}×${v.videoHeight} (약 ${mp}MP)`;
}

function showFallback(msg) {
  $('camError').textContent = msg;
  $('camFallback').hidden = false;
  $('btnShutter').disabled = true;
  $('btnSwitch').disabled = true;
  renderOverlay();
  updateFlashUI();
}

$('btnRetry').onclick = startCamera;
$('btnFlash').onclick = async () => {
  const order = ['off', 'shot', 'on'];
  s.flashMode = order[(order.indexOf(s.flashMode) + 1) % order.length];
  persist();
  await applyFlash();
  toast(FLASH_HINT[s.flashMode]);
};
$('btnSwitch').onclick = async () => {
  try {
    s.facing = await camera.switchFacing();
    persist();
    updateResInfo();
    renderOverlay();
    await applyFlash();
  } catch (e) {
    showFallback(cameraErrorMessage(e));
  }
};

let resumeCamera = false;
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    resumeCamera = camera.active;
    camera.stop();
  } else if (resumeCamera) {
    resumeCamera = false;
    startCamera();
  }
});

/* ── 촬영 → 스탬프 → 저장 ───────────────────────── */
async function makeThumb(canvas) {
  const max = 240;
  const r = Math.min(1, max / Math.max(canvas.width, canvas.height));
  const t = document.createElement('canvas');
  t.width = Math.round(canvas.width * r);
  t.height = Math.round(canvas.height * r);
  t.getContext('2d').drawImage(canvas, 0, 0, t.width, t.height);
  return canvasToBlob(t, 0.7);
}

function stampToCanvas(source, width, height, date) {
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  const ctx = c.getContext('2d');
  ctx.drawImage(source, 0, 0, width, height);
  drawStamp(ctx, width, height, currentTexts(date), s);
  return c;
}

// 스탬프 찍힌 canvas 하나를 저장 방식대로 저장하고, 성공하면 번호를 올린다.
async function storeStamped(canvas, date, { allowShare = true } = {}) {
  const numberText = formatNumber(s.current, s);
  const name = buildFileName(s.fileName, numberText, date);
  const blob = await canvasToBlob(canvas, s.quality / 100);
  const thumb = await makeThumb(canvas);

  let saved = false;
  let listId = null;
  let note = '';
  const mode = s.saveMode === 'share' && !allowShare ? 'list' : s.saveMode;

  if (s.keepInList || mode === 'list') {
    try {
      listId = await addShot({
        name, numberText, createdAt: date.getTime(), blob, thumb, width: canvas.width, height: canvas.height,
      });
      saved = true;
    } catch (e) {
      console.error(e);
      toast('앱 목록에 저장하지 못했습니다: ' + (e.message || e), 3000);
      if (mode === 'list') return false;
    }
  }
  if (mode === 'download') {
    downloadBlob(blob, name);
    saved = true;
  } else if (mode === 'share') {
    try {
      const ok = await shareBlob(blob, name);
      if (ok) saved = true;
      else if (saved) note = ' (공유 취소, 앱 목록에만 저장)';
    } catch (e) {
      // 공유가 막히면 다운로드로 대신한다
      console.warn(e);
      downloadBlob(blob, name);
      saved = true;
      note = ' (공유 불가 → 다운로드)';
    }
  }

  if (!saved) {
    toast('저장 취소 — 번호는 그대로입니다.');
    return false;
  }
  undoStack.push({ number: s.current, listId, numberText });
  if (undoStack.length > 50) undoStack.shift();
  s.current = nextValue(s.current, s);
  persist();
  setLastThumb(thumb);
  updateNext();
  renderOverlay();
  refreshListBadge();
  toast(`${numberText} 저장됨${note}`);
  return true;
}

async function shoot() {
  if (busy || !camera.active) return;
  busy = true;
  $('btnShutter').disabled = true;
  // "촬영" 모드: 찍기 직전에 켜고, 카메라 노출이 맞춰질 때까지 잠깐 기다린 뒤 찍고 끈다
  let lit = s.flashMode === 'shot' && (await camera.setTorch(true));
  try {
    if (lit) await sleep(FLASH_SETTLE_MS);
    const date = new Date();
    const shot = await camera.capture(s.hiRes);
    if (lit) {
      lit = false;
      await camera.setTorch(false);
    }
    const f = $('flash');
    f.classList.remove('on');
    void f.offsetWidth;
    f.classList.add('on');
    if (navigator.vibrate) navigator.vibrate(30);
    const canvas = stampToCanvas(shot.source, shot.width, shot.height, date);
    await storeStamped(canvas, date);
  } catch (e) {
    console.error(e);
    toast('촬영 실패: ' + (e.message || e), 3000);
  } finally {
    if (lit) camera.setTorch(false); // 촬영 중 오류가 나도 손전등은 끈다
    busy = false;
    $('btnShutter').disabled = !camera.active;
  }
}
$('btnShutter').onclick = shoot;
document.addEventListener('keydown', (e) => {
  const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement && document.activeElement.tagName);
  if (typing || !$('settingsSheet').hidden || !$('listSheet').hidden || !$('viewer').hidden) return;
  if (e.code === 'Space' || e.code === 'Enter' || e.code === 'AudioVolumeUp' || e.code === 'AudioVolumeDown') {
    e.preventDefault();
    shoot();
  }
});

// 파일(기본 카메라 앱 / 갤러리)에 스탬프 찍기
async function stampFiles(files, { fromGallery }) {
  if (!files.length) return;
  busy = true;
  let done = 0;
  try {
    for (const file of files) {
      const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
      // 갤러리 사진은 파일의 수정 시각(대개 촬영 시각)을 날짜로 쓴다
      const date = fromGallery && file.lastModified ? new Date(file.lastModified) : new Date();
      const canvas = stampToCanvas(bmp, bmp.width, bmp.height, date);
      bmp.close && bmp.close();
      if (await storeStamped(canvas, date, { allowShare: files.length === 1 })) done++;
    }
    if (files.length > 1) toast(`${done}장에 번호를 찍었습니다. 목록에서 ZIP으로 내보낼 수 있습니다.`, 3000);
  } catch (e) {
    console.error(e);
    toast('사진을 처리하지 못했습니다: ' + (e.message || e), 3000);
  } finally {
    busy = false;
    refreshList();
  }
}
$('btnNativeCam').onclick = () => $('fileNative').click();
$('btnGallery').onclick = () => $('fileGallery').click();
$('btnGallery2').onclick = () => $('fileGallery').click();
$('fileNative').onchange = (e) => {
  stampFiles([...e.target.files], { fromGallery: false });
  e.target.value = '';
};
$('fileGallery').onchange = (e) => {
  stampFiles([...e.target.files], { fromGallery: true });
  e.target.value = '';
};

/* ── 되돌리기 ───────────────────────────────────── */
$('btnUndo').onclick = async () => {
  const last = undoStack.pop();
  if (!last) return;
  s.current = last.number;
  persist();
  let msg = `${last.numberText} 취소 — 다음 번호 ${formatNumber(s.current, s)}`;
  if (last.listId != null) {
    try {
      await deleteShot(last.listId);
    } catch (e) { /* 이미 지워짐 */ }
  }
  if (s.saveMode === 'download') msg += ' (다운로드된 파일은 직접 지워 주세요)';
  updateNext();
  renderOverlay();
  refreshListBadge();
  toast(msg, 3000);
};

/* ── 설정 패널 ──────────────────────────────────── */
const sel = $('s-dateFormat');
const sample = new Date();
for (const f of DATE_FORMATS) sel.add(new Option(`${formatDate(sample, f)}  (${f})`, f));

const fields = ['numberOn', 'current', 'start', 'step', 'pad', 'prefix', 'suffix', 'margin', 'size', 'bold', 'color',
  'outline', 'outlineWidth', 'outlineColor', 'box', 'boxColor', 'boxOpacity', 'dateOn', 'dateFormat',
  'dateLayout', 'saveMode', 'keepInList', 'fileName', 'quality', 'hiRes'];
const outputs = {
  margin: (v) => v + '%', size: (v) => v + '%', outlineWidth: (v) => v, boxOpacity: (v) => v + '%', quality: (v) => v,
};

function fillSettingsUI() {
  for (const k of fields) {
    const el = $('s-' + k);
    if (el.type === 'checkbox') el.checked = s[k];
    else el.value = String(s[k]);
    if (outputs[k]) $('o-' + k).textContent = outputs[k](s[k]);
  }
  document.querySelectorAll('#s-position button').forEach((b) => b.classList.toggle('on', b.dataset.pos === s.position));
  syncDisabled();
}

function syncDisabled() {
  $('s-outlineColor').disabled = $('s-outlineWidth').disabled = !s.outline;
  $('s-boxColor').disabled = $('s-boxOpacity').disabled = !s.box;
  $('s-dateFormat').disabled = $('s-dateLayout').disabled = !s.dateOn;
  $('s-keepInList').disabled = s.saveMode === 'list';
}

for (const k of fields) {
  const el = $('s-' + k);
  const handler = () => {
    let v;
    if (el.type === 'checkbox') v = el.checked;
    else if (typeof DEFAULTS[k] === 'number') {
      v = Number(el.value);
      if (el.value === '' || !Number.isFinite(v)) return;
      if (['current', 'start', 'step', 'pad'].includes(k)) v = Math.trunc(v);
    } else v = el.value;
    s[k] = v;
    if (outputs[k]) $('o-' + k).textContent = outputs[k](v);
    persist();
    syncDisabled();
    updateNext();
    renderOverlay();
  };
  el.addEventListener('input', handler);
  el.addEventListener('change', () => {
    handler();
    if (el.type === 'number') el.value = String(s[k]); // 빈 칸·소수점 입력은 저장된 값으로 되돌림
  });
}
document.querySelectorAll('#s-position button').forEach((b) => {
  b.onclick = () => {
    s.position = b.dataset.pos;
    persist();
    fillSettingsUI();
    renderOverlay();
  };
});
$('btnResetNum').onclick = () => {
  s.current = s.start;
  undoStack.length = 0;
  persist();
  fillSettingsUI();
  updateNext();
  renderOverlay();
  toast(`다음 번호를 ${formatNumber(s.current, s)}(으)로 바꿨습니다.`);
};
$('btnResetAll').onclick = () => {
  if (!confirm('모든 설정을 처음 상태로 되돌릴까요? (촬영 목록은 그대로)')) return;
  const facing = s.facing;
  s = { ...DEFAULTS, facing };
  undoStack.length = 0;
  persist();
  fillSettingsUI();
  updateNext();
  renderOverlay();
};

function openSheet(id) {
  document.querySelectorAll('.sheet').forEach((el) => (el.hidden = el.id !== id));
}
document.querySelectorAll('[data-close]').forEach((b) => (b.onclick = () => (b.closest('.sheet').hidden = true)));
$('btnSettings').onclick = () => {
  if (!$('settingsSheet').hidden) return ($('settingsSheet').hidden = true);
  fillSettingsUI();
  openSheet('settingsSheet');
};
$('btnNext').onclick = () => {
  fillSettingsUI();
  openSheet('settingsSheet');
  const inp = $('s-current');
  $('secNumber').scrollIntoView({ block: 'start' });
  inp.focus();
  inp.select();
};

/* ── 촬영 목록 ──────────────────────────────────── */
function setLastThumb(blob) {
  if (lastThumbUrl) URL.revokeObjectURL(lastThumbUrl);
  lastThumbUrl = blob ? URL.createObjectURL(blob) : null;
  if (lastThumbUrl) $('lastThumb').src = lastThumbUrl;
  else $('lastThumb').removeAttribute('src');
}

async function refreshListBadge() {
  try {
    const items = await listShots();
    $('listCount').hidden = items.length === 0;
    $('listCount').textContent = items.length;
    if (!items.length && !lastThumbUrl) setLastThumb(null);
    return items;
  } catch (e) {
    console.error(e);
    return [];
  }
}

let gridUrls = [];
async function refreshList() {
  const items = await refreshListBadge();
  gridUrls.forEach((u) => URL.revokeObjectURL(u));
  gridUrls = [];
  const grid = $('listGrid');
  grid.textContent = '';
  const total = items.reduce((a, i) => a + i.size, 0);
  $('listSummary').textContent = items.length ? `${items.length}장 · ${(total / 1048576).toFixed(1)}MB` : '';
  $('listEmpty').hidden = items.length > 0;
  $('btnZip').disabled = $('btnClear').disabled = items.length === 0;
  for (const it of items) {
    const b = document.createElement('button');
    b.className = 'list-item';
    const img = document.createElement('img');
    if (it.thumb) {
      const u = URL.createObjectURL(it.thumb);
      gridUrls.push(u);
      img.src = u;
    }
    img.alt = it.name;
    const cap = document.createElement('span');
    cap.textContent = it.numberText;
    b.append(img, cap);
    b.onclick = () => openViewer(it.id);
    grid.append(b);
  }
}

$('btnList').onclick = async () => {
  openSheet('listSheet');
  await refreshList();
};

$('btnZip').onclick = async () => {
  const btn = $('btnZip');
  btn.disabled = true;
  btn.textContent = 'ZIP 만드는 중…';
  try {
    const items = await allShotsWithBlobs();
    const names = uniqueNames(items.map((i) => i.name));
    const zip = await makeZip(items.map((i, n) => ({ name: names[n], blob: i.blob, date: new Date(i.createdAt) })));
    const d = new Date();
    const stamp = buildFileName('{date}_{time}', '', d).replace(/\.jpg$/, '');
    downloadBlob(zip, `스탬프사진_${stamp}.zip`);
    toast(`${items.length}장을 ZIP으로 내보냈습니다.`);
  } catch (e) {
    console.error(e);
    toast('ZIP을 만들지 못했습니다: ' + (e.message || e), 3000);
  } finally {
    btn.textContent = 'ZIP으로 내보내기';
    btn.disabled = false;
  }
};

$('btnClear').onclick = async () => {
  if (!confirm('촬영 목록의 사진을 모두 지울까요? 되돌릴 수 없습니다.\n(이미 다운로드한 파일은 지워지지 않습니다)')) return;
  await clearShots();
  undoStack.forEach((u) => (u.listId = null));
  setLastThumb(null);
  await refreshList();
  toast('촬영 목록을 비웠습니다.');
};

/* ── 사진 보기 ──────────────────────────────────── */
let viewerItem = null;
let viewerUrl = null;
async function openViewer(id) {
  const it = await getShot(id);
  if (!it) return refreshList();
  viewerItem = it;
  if (viewerUrl) URL.revokeObjectURL(viewerUrl);
  viewerUrl = URL.createObjectURL(it.blob);
  $('viewerImg').src = viewerUrl;
  $('viewerName').textContent = `${it.name} · ${it.width ? `${it.width}×${it.height} · ` : ''}${(it.blob.size / 1024).toFixed(0)}KB`;
  $('viewer').hidden = false;
}
function closeViewer() {
  $('viewer').hidden = true;
  $('viewerImg').removeAttribute('src');
  if (viewerUrl) URL.revokeObjectURL(viewerUrl);
  viewerUrl = null;
  viewerItem = null;
}
$('vClose').onclick = closeViewer;
$('vDownload').onclick = () => viewerItem && downloadBlob(viewerItem.blob, viewerItem.name);
$('vShare').onclick = async () => {
  if (!viewerItem) return;
  try {
    await shareBlob(viewerItem.blob, viewerItem.name);
  } catch (e) {
    toast(e.message || String(e), 3000);
  }
};
$('vDelete').onclick = async () => {
  if (!viewerItem || !confirm(`${viewerItem.name} 을(를) 목록에서 지울까요?`)) return;
  const id = viewerItem.id;
  await deleteShot(id);
  undoStack.forEach((u) => u.listId === id && (u.listId = null));
  closeViewer();
  await refreshList();
};

/* ── 시작 ───────────────────────────────────────── */
$('appVersion').textContent = 'v' + APP_VERSION;
fillSettingsUI();
updateNext();
refreshListBadge().then(async (items) => {
  if (items[0] && items[0].thumb) setLastThumb(items[0].thumb);
});
requestPersist();
startCamera();

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn('서비스워커 등록 실패', e));
}
