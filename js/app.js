// 전체 연결과 UI 이벤트.
import { loadSettings, saveSettings, DEFAULTS } from './settings.js';
import { formatNumber, nextValue, formatDate, buildFileName, DATE_FORMATS } from './counter.js';
import { drawStamp } from './stamp.js';
import { Camera, cameraErrorMessage, crop43, zoomCrop } from './camera.js';
import { addShot, deleteShot, clearShots, getShot, listShots, allShotsWithBlobs, requestPersist } from './storage.js';
import { downloadBlob, shareBlob, shareFiles, canvasToBlob } from './save.js';
import { makeZip, uniqueNames } from './zip.js';
import { shotsCsv } from './csv.js';

const APP_VERSION = '1.7.0';
const $ = (id) => document.getElementById(id);

let s = loadSettings();
const camera = new Camera($('video'));
const undoStack = []; // { number, sub, sameOn, listId, numberText }
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

// 다음에 찍힐 번호 (같은 번호 모드면 0012-2 처럼 뒤 번호까지)
const currentNumberText = () => formatNumber(s.current, s, s.sameOn ? s.sub : 0);

function currentTexts(date) {
  return {
    numberText: s.numberOn ? currentNumberText() : '',
    memoText: s.memoOn ? s.memo.trim() : '',
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
  const no = currentNumberText();
  $('nextText').textContent = no;
  $('btnUndo').disabled = undoStack.length === 0;
  $('btnSame').setAttribute('aria-pressed', String(s.sameOn));
  const memo = s.memo.trim();
  $('memoText').textContent = memo || '없음';
  $('btnMemo').classList.toggle('has', !!memo);
  $('fileNamePreview').textContent = buildFileName(s.fileName, no, new Date(), memo);
}

/* ── 미리보기 오버레이 ───────────────────────────── */
function renderOverlay() {
  const ov = $('overlay');
  const v = $('video');
  const guides = $('guides');
  if (!camera.active || !v.videoWidth) {
    ov.hidden = guides.hidden = true;
    return;
  }
  ov.hidden = false;
  guides.hidden = !(s.gridOn || s.levelOn);
  guides.classList.toggle('grid', s.gridOn);
  const stage = $('stage').getBoundingClientRect();
  // object-fit: contain 으로 그려진 실제 영상 영역 안에서, 저장될 4:3 영역에만 겹친다
  const scale = Math.min(stage.width / v.videoWidth, stage.height / v.videoHeight);
  const crop = crop43(v.videoWidth, v.videoHeight);
  const w = crop.w * scale;
  const h = crop.h * scale;
  const dpr = window.devicePixelRatio || 1;
  ov.style.width = w + 'px';
  ov.style.height = h + 'px';
  ov.style.left = (stage.width - v.videoWidth * scale) / 2 + crop.x * scale + 'px';
  ov.style.top = (stage.height - v.videoHeight * scale) / 2 + crop.y * scale + 'px';
  Object.assign(guides.style, { width: ov.style.width, height: ov.style.height, left: ov.style.left, top: ov.style.top });
  // 잘려 나갈 부분은 어둡게
  ov.classList.toggle('cropped', crop.w !== v.videoWidth || crop.h !== v.videoHeight);
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
    resetZoom();
    updateResInfo();
    renderOverlay();
    await applyFlash();
  } catch (e) {
    console.error(e);
    showFallback(cameraErrorMessage(e));
  }
}

// 설정 › 카메라 안내: 지금 설정(고화질 켬/끔)으로 찍힐 해상도 + 최근 저장한 사진의 실제 크기·용량
let lastSaved = null; // { w, h, size, quality }
let resInfoSeq = 0;
async function updateResInfo() {
  const v = $('video');
  const seq = ++resInfoSeq;
  const res = $('resInfo');
  const last = $('lastSavedInfo');
  last.textContent = lastSaved
    ? `최근 저장: ${lastSaved.w}×${lastSaved.h} · ${fmtSize(lastSaved.size)} (품질 ${lastSaved.quality})`
    : '';
  if (!v.videoWidth) return (res.textContent = '');
  const fmt = (w, h) => `${w}×${h} (약 ${((w * h) / 1e6).toFixed(1)}MP, ${w >= h ? '4:3' : '3:4'})`;
  const video = crop43(v.videoWidth, v.videoHeight);
  if (!s.hiRes) return (res.textContent = `지금 저장 해상도: ${fmt(video.w, video.h)}`);
  res.textContent = '지금 저장 해상도: 고화질 확인 중…';
  const p = await camera.photoSize();
  if (seq !== resInfoSeq) return; // 그새 다시 불렸으면 버림
  if (p && p.width * p.height > v.videoWidth * v.videoHeight) {
    const c = crop43(p.width, p.height);
    res.textContent = `지금 저장 해상도: ${fmt(c.w, c.h)} — 고화질`;
  } else if (p) {
    res.textContent = `지금 저장 해상도: ${fmt(video.w, video.h)} — 이 기기는 고화질(${p.width}×${p.height})이 더 작아서 지금 화질 그대로 찍습니다`;
  } else {
    res.textContent = `지금 저장 해상도: ${fmt(video.w, video.h)} — 이 기기는 고화질 촬영을 지원하지 않아 그대로입니다`;
  }
}
const fmtSize = (b) => (b >= 1048576 ? (b / 1048576).toFixed(1) + 'MB' : Math.round(b / 1024) + 'KB');

function showFallback(msg) {
  $('camError').textContent = msg;
  $('camFallback').hidden = false;
  $('btnShutter').disabled = true;
  $('btnSwitch').disabled = true;
  $('zoomBar').hidden = true;
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
    resetZoom();
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

// crop: 원본에서 잘라 쓸 영역 (없으면 전체), out: 저장 크기 (디지털 줌은 잘라낸 가운데를 원래 크기로 키움)
function stampToCanvas(source, width, height, date, crop = { x: 0, y: 0, w: width, h: height }, out = crop) {
  const c = document.createElement('canvas');
  c.width = out.w;
  c.height = out.h;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, crop.x, crop.y, crop.w, crop.h, 0, 0, out.w, out.h);
  drawStamp(ctx, out.w, out.h, currentTexts(date), s);
  return c;
}

// 스탬프 찍힌 canvas 하나를 저장 방식대로 저장하고, 성공하면 번호를 올린다.
async function storeStamped(canvas, date, { allowShare = true } = {}) {
  const numberText = currentNumberText();
  const memo = s.memo.trim();
  const name = buildFileName(s.fileName, numberText, date, memo);
  const blob = await canvasToBlob(canvas, s.quality / 100);
  const thumb = await makeThumb(canvas);

  let saved = false;
  let listId = null;
  let note = '';
  const mode = s.saveMode === 'share' && !allowShare ? 'list' : s.saveMode;

  if (s.keepInList || mode === 'list') {
    try {
      listId = await addShot({
        name, numberText, memo, createdAt: date.getTime(), blob, thumb, width: canvas.width, height: canvas.height,
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
  lastSaved = { w: canvas.width, h: canvas.height, size: blob.size, quality: s.quality };
  updateResInfo();
  undoStack.push({ number: s.current, sub: s.sub, sameOn: s.sameOn, listId, numberText });
  if (undoStack.length > 50) undoStack.shift();
  if (s.sameOn) s.sub++; // 같은 번호 모드: 뒤 번호만 올림
  else s.current = nextValue(s.current, s);
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
    // 카메라 촬영은 항상 4:3으로 (갤러리·기본 카메라 앱 사진은 원본 비율 그대로)
    const crop = crop43(shot.width, shot.height);
    const canvas = stampToCanvas(shot.source, shot.width, shot.height, date, zoomCrop(crop, digitalZoom()), crop);
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
  if (typing || !$('settingsSheet').hidden || !$('listSheet').hidden || !$('memoSheet').hidden || !$('viewer').hidden) return;
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
  s.sub = last.sub;
  s.sameOn = last.sameOn;
  persist();
  let msg = `${last.numberText} 취소 — 다음 번호 ${currentNumberText()}`;
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
for (const f of DATE_FORMATS) sel.add(new Option(formatDate(sample, f), f));

const fields = ['numberOn', 'current', 'start', 'step', 'pad', 'prefix', 'suffix', 'subSep', 'memoOn', 'memo',
  'margin', 'size', 'bold', 'color', 'outline', 'outlineWidth', 'outlineColor', 'box', 'boxColor', 'boxOpacity',
  'dateOn', 'dateFormat', 'dateLayout', 'saveMode', 'keepInList', 'fileName', 'quality', 'hiRes', 'gridOn', 'levelOn'];
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
  const presets = [...$('fileNamePreset').options].map((o) => o.value).filter(Boolean);
  $('fileNamePreset').value = presets.includes(s.fileName) ? s.fileName : '';
  syncDisabled();
}

// 파일명: 목록에서 고르거나 "직접 입력"
$('fileNamePreset').addEventListener('change', (e) => {
  if (e.target.value) {
    s.fileName = e.target.value;
    $('s-fileName').value = s.fileName;
    persist();
  }
  syncDisabled();
  updateNext();
  if (!e.target.value) $('s-fileName').focus();
});

function syncDisabled() {
  $('s-outlineColor').disabled = $('s-outlineWidth').disabled = !s.outline;
  $('s-boxColor').disabled = $('s-boxOpacity').disabled = !s.box;
  $('s-dateFormat').disabled = $('s-dateLayout').disabled = !s.dateOn;
  $('s-keepInList').disabled = s.saveMode === 'list';
  $('fileNameCustom').hidden = $('fileNameTokens').hidden = $('fileNamePreset').value !== '';
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
    if (k === 'current') s.sub = 1; // 번호를 직접 바꾸면 뒤 번호는 1부터
    if (outputs[k]) $('o-' + k).textContent = outputs[k](v);
    persist();
    syncDisabled();
    updateNext();
    renderOverlay();
    if (k === 'hiRes') updateResInfo();
    if (k === 'levelOn') syncLevel();
  };
  el.addEventListener('input', handler);
  el.addEventListener('change', () => {
    handler();
    if (el.type === 'number') el.value = String(s[k]); // 빈 칸·소수점 입력은 저장된 값으로 되돌림
    if (k === 'memo') setMemo(el.value); // 입력을 마치면 최근 메모에 넣음
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
  s.sub = 1;
  undoStack.length = 0;
  persist();
  fillSettingsUI();
  updateNext();
  renderOverlay();
  toast(`다음 번호를 ${currentNumberText()}(으)로 바꿨습니다.`);
};
$('btnResetAll').onclick = () => {
  if (!confirm('모든 설정을 처음 상태로 되돌릴까요? (촬영 목록은 그대로)')) return;
  const facing = s.facing;
  s = { ...DEFAULTS, facing, memoRecent: s.memoRecent };
  undoStack.length = 0;
  persist();
  fillSettingsUI();
  updateNext();
  renderOverlay();
  syncLevel();
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
// 선택 모드: 고른 사진 id 모음
let selecting = false;
const selected = new Set();
let listIds = [];

async function refreshList() {
  const items = await refreshListBadge();
  gridUrls.forEach((u) => URL.revokeObjectURL(u));
  gridUrls = [];
  const grid = $('listGrid');
  grid.textContent = '';
  listIds = items.map((i) => i.id);
  for (const id of [...selected]) if (!listIds.includes(id)) selected.delete(id);
  if (!items.length) selecting = false;
  const total = items.reduce((a, i) => a + i.size, 0);
  $('listSummary').textContent = items.length ? `${items.length}장 · ${(total / 1048576).toFixed(1)}MB` : '';
  $('listEmpty').hidden = items.length > 0;
  $('btnZip').disabled = $('btnClear').disabled = $('btnSelect').disabled = $('btnCsv').disabled = items.length === 0;
  for (const it of items) {
    const b = document.createElement('button');
    b.className = 'list-item';
    b.dataset.id = it.id;
    const img = document.createElement('img');
    if (it.thumb) {
      const u = URL.createObjectURL(it.thumb);
      gridUrls.push(u);
      img.src = u;
    }
    img.alt = it.name;
    const cap = document.createElement('span');
    cap.textContent = it.memo ? `${it.numberText} · ${it.memo}` : it.numberText;
    b.append(img, cap);
    bindListItem(b, it.id);
    grid.append(b);
  }
  renderSelection();
  return items;
}

// 누르면 보기(선택 모드에서는 고르기), 길게 누르면 선택 모드로
function bindListItem(b, id) {
  let timer = null;
  let longPressed = false;
  let start = null;
  const cancel = () => {
    clearTimeout(timer);
    timer = null;
  };
  b.addEventListener('pointerdown', (e) => {
    longPressed = false;
    start = { x: e.clientX, y: e.clientY };
    cancel();
    timer = setTimeout(() => {
      timer = null;
      longPressed = true;
      if (!selecting) setSelecting(true);
      selected.add(id);
      renderSelection();
      if (navigator.vibrate) navigator.vibrate(30);
    }, 500);
  });
  b.addEventListener('pointermove', (e) => {
    if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 10) cancel();
  });
  b.addEventListener('pointerup', cancel);
  b.addEventListener('pointercancel', cancel);
  b.addEventListener('contextmenu', (e) => e.preventDefault());
  b.addEventListener('click', () => {
    if (longPressed) {
      longPressed = false;
      return;
    }
    if (!selecting) return openViewer(id);
    if (selected.has(id)) selected.delete(id);
    else selected.add(id);
    renderSelection();
  });
}

function setSelecting(on) {
  selecting = on;
  if (!on) selected.clear();
  renderSelection();
}

function renderSelection() {
  const n = selected.size;
  $('listGrid').classList.toggle('selecting', selecting);
  $('listActions').hidden = selecting;
  $('selBar').hidden = !selecting;
  $('listTip').hidden = selecting || listIds.length === 0;
  $('selCount').textContent = `${n}장 선택`;
  $('selAll').textContent = n && n === listIds.length ? '선택 해제' : '전체 선택';
  ['selDownload', 'selZip', 'selShare', 'selDelete'].forEach((k) => ($(k).disabled = n === 0));
  document.querySelectorAll('#listGrid .list-item').forEach((b) => b.classList.toggle('sel', selected.has(Number(b.dataset.id))));
}

// 고른 사진(원본 포함)을 찍은 순서대로
async function selectedShots() {
  const ids = listIds.filter((id) => selected.has(id)).sort((a, b) => a - b);
  return (await Promise.all(ids.map((id) => getShot(id)))).filter(Boolean);
}

async function exportZip(items, btn) {
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'ZIP 만드는 중…';
  try {
    const names = uniqueNames(items.map((i) => i.name));
    const files = items.map((i, n) => ({ name: names[n], blob: i.blob, date: new Date(i.createdAt) }));
    files.push({ name: '목록.csv', blob: shotsCsv(items, names), date: new Date() }); // 번호·메모·시각 목록
    const zip = await makeZip(files);
    const stamp = nowStamp();
    downloadBlob(zip, `스탬프사진_${stamp}.zip`);
    toast(`${items.length}장을 ZIP으로 내보냈습니다.`);
  } catch (e) {
    console.error(e);
    toast('ZIP을 만들지 못했습니다: ' + (e.message || e), 3000);
  } finally {
    btn.textContent = label;
    btn.disabled = false;
  }
}

// 지운 뒤: 되돌리기 기록 정리, 목록·썸네일 갱신
async function afterDelete(ids) {
  undoStack.forEach((u) => ids.includes(u.listId) && (u.listId = null));
  const items = await refreshList();
  setLastThumb(items[0] && items[0].thumb ? items[0].thumb : null);
}

$('btnList').onclick = async () => {
  openSheet('listSheet');
  setSelecting(false);
  await refreshList();
};

$('btnZip').onclick = async () => exportZip(await allShotsWithBlobs(), $('btnZip'));
const nowStamp = () => buildFileName('{date}_{time}', '', new Date()).replace(/\.jpg$/, '');
$('btnCsv').onclick = async () => {
  const items = await allShotsWithBlobs();
  downloadBlob(shotsCsv(items, uniqueNames(items.map((i) => i.name))), `스탬프목록_${nowStamp()}.csv`);
  toast(`${items.length}장 목록을 CSV로 내보냈습니다 (엑셀에서 열기).`);
};

$('btnSelect').onclick = () => setSelecting(true);
$('selCancel').onclick = () => setSelecting(false);
$('selAll').onclick = () => {
  if (selected.size === listIds.length) selected.clear();
  else listIds.forEach((id) => selected.add(id));
  renderSelection();
};
$('selZip').onclick = async () => exportZip(await selectedShots(), $('selZip'));
$('selDownload').onclick = async () => {
  const items = await selectedShots();
  const names = uniqueNames(items.map((i) => i.name));
  // 여러 장이면 크롬이 "여러 파일 다운로드 허용"을 한 번 물어본다
  for (let n = 0; n < items.length; n++) {
    downloadBlob(items[n].blob, names[n]);
    if (n < items.length - 1) await new Promise((r) => setTimeout(r, 300));
  }
  toast(`${items.length}장을 다운로드했습니다.`);
};
$('selShare').onclick = async () => {
  try {
    const items = await selectedShots();
    await shareFiles(items.map((i) => ({ blob: i.blob, name: i.name })));
  } catch (e) {
    toast(e.message || String(e), 3000);
  }
};
$('selDelete').onclick = async () => {
  const ids = [...selected];
  if (!ids.length || !confirm(`선택한 ${ids.length}장을 목록에서 지울까요? 되돌릴 수 없습니다.\n(이미 다운로드한 파일은 지워지지 않습니다)`)) return;
  for (const id of ids) await deleteShot(id);
  setSelecting(false);
  await afterDelete(ids);
  toast(`${ids.length}장을 지웠습니다.`);
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
  $('viewerName').textContent = `${it.name}${it.memo ? ` (${it.memo})` : ''} · ${it.width ? `${it.width}×${it.height} · ` : ''}${(it.blob.size / 1024).toFixed(0)}KB`;
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
  closeViewer();
  await afterDelete([id]);
};

/* ── 같은 번호로 여러 장 ─────────────────────────── */
// 켜기: 방금 찍은 사진(뒤 번호 없음)이 있으면 그 번호에 이어서 0012 → 0012-2, 아니면 지금 번호 -1부터
// 끄기: 같은 번호로 한 장이라도 찍었으면 다음 번호로
$('btnSame').onclick = () => {
  if (!s.sameOn) {
    const top = undoStack[undoStack.length - 1];
    const cont = top && !top.sameOn && s.current === nextValue(top.number, s);
    if (cont) s.current = top.number;
    s.sub = cont ? 2 : 1;
    s.sameOn = true;
    const after = formatNumber(nextValue(s.current, s), s);
    toast(`같은 번호${cont ? ' 이어서' : ''}: ${currentNumberText()}, ${formatNumber(s.current, s, s.sub + 1)} … (다시 누르면 ${after})`, 3000);
  } else {
    if (s.sub > 1) s.current = nextValue(s.current, s);
    s.sub = 1;
    s.sameOn = false;
    toast(`같은 번호 끝 — 다음 번호 ${currentNumberText()}`);
  }
  persist();
  updateNext();
  renderOverlay();
};

/* ── 메모 ───────────────────────────────────────── */
function setMemo(v) {
  const m = String(v || '').trim().slice(0, 60);
  s.memo = m;
  if (m) s.memoRecent = [m, ...s.memoRecent.filter((x) => x !== m)].slice(0, 12);
  persist();
  updateNext();
  renderOverlay();
  if (!$('settingsSheet').hidden) $('s-memo').value = m;
}

function renderMemoRecent() {
  const box = $('memoRecent');
  box.textContent = '';
  $('memoRecentHint').hidden = s.memoRecent.length === 0;
  for (const m of s.memoRecent) {
    const chip = document.createElement('span');
    chip.className = 'chip' + (m === s.memo ? ' cur' : '');
    const pick = document.createElement('button');
    pick.type = 'button';
    pick.textContent = m;
    pick.onclick = () => {
      setMemo(m);
      $('memoSheet').hidden = true;
      toast(`메모: ${m}`);
    };
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'x';
    x.textContent = '×';
    x.setAttribute('aria-label', `${m} 최근 메모에서 지우기`);
    x.onclick = () => {
      s.memoRecent = s.memoRecent.filter((r) => r !== m);
      persist();
      renderMemoRecent();
    };
    chip.append(pick, x);
    box.append(chip);
  }
}

$('btnMemo').onclick = () => {
  $('memoInput').value = s.memo;
  $('memoOn2').checked = s.memoOn;
  renderMemoRecent();
  openSheet('memoSheet');
  setTimeout(() => {
    $('memoInput').focus();
    $('memoInput').select();
  }, 50);
};
$('memoForm').onsubmit = (e) => {
  e.preventDefault();
  setMemo($('memoInput').value);
  $('memoInput').blur();
  $('memoSheet').hidden = true;
  toast(s.memo ? `메모: ${s.memo}` : '메모 없음');
};
$('memoNone').onclick = () => {
  setMemo('');
  $('memoSheet').hidden = true;
  toast('메모 없음');
};
$('memoOn2').onchange = (e) => {
  s.memoOn = e.target.checked;
  persist();
  renderOverlay();
};
$('btnMemoClear').onclick = () => setMemo('');

/* ── 줌 ─────────────────────────────────────────── */
// 카메라가 줌을 지원하면 카메라 줌(광학/센서), 아니면 미리보기와 저장 사진을 가운데로 잘라 키우는 디지털 줌
const DIGITAL_ZOOM_MAX = 4;
let zoom = 1;
let zoomHw = null; // { min, max, step } 또는 null
const digitalZoom = () => (zoomHw ? 1 : zoom);
const zoomLimits = () => (zoomHw ? { min: zoomHw.min, max: zoomHw.max } : { min: 1, max: DIGITAL_ZOOM_MAX });
const fmtZoom = (z) => (Math.abs(z - Math.round(z)) < 0.05 ? String(Math.round(z)) : z.toFixed(1)) + '×';

function zoomPresets() {
  const { min, max } = zoomLimits();
  const list = [min < 1 ? min : null, 1, 2, 4, 10].filter((v) => v != null && v >= min - 1e-6 && v <= max + 1e-6);
  return [...new Set(list)];
}

function renderZoomBar() {
  const bar = $('zoomBar');
  const presets = zoomPresets();
  bar.hidden = !camera.active || presets.length < 2;
  if (bar.hidden) return;
  // 지금 배율에 가장 가까운(같거나 아래) 단계 버튼이 켜지고, 그 버튼에 지금 배율이 보인다
  let on = 0;
  presets.forEach((v, n) => (zoom >= v - 0.05 ? (on = n) : 0));
  if (bar.children.length !== presets.length) {
    bar.textContent = '';
    for (const v of presets) {
      const b = document.createElement('button');
      b.type = 'button';
      b.onclick = () => setZoom(v);
      bar.append(b);
    }
  }
  [...bar.children].forEach((b, n) => {
    b.dataset.z = presets[n];
    b.classList.toggle('on', n === on);
    b.textContent = n === on ? fmtZoom(zoom) : fmtZoom(presets[n]);
    b.setAttribute('aria-label', `${fmtZoom(presets[n])} 확대`);
  });
}

let zoomBusy = false;
let zoomWanted = null;
async function applyHwZoom(z) {
  zoomWanted = z;
  if (zoomBusy) return;
  zoomBusy = true;
  while (zoomWanted != null) {
    const v = zoomWanted;
    zoomWanted = null;
    await camera.setZoom(v);
  }
  zoomBusy = false;
}

function setZoom(z) {
  const { min, max } = zoomLimits();
  zoom = Math.min(max, Math.max(min, z));
  if (zoomHw) applyHwZoom(zoom);
  $('stage').style.setProperty('--dz', String(digitalZoom()));
  renderZoomBar();
}

function resetZoom() {
  zoomHw = camera.zoomRange;
  setZoom(1);
}

/* ── 눌러서 초점 · 두 손가락 확대 ─────────────────── */
let focusWarned = false;
async function focusTap(cx, cy) {
  const v = $('video');
  if (!camera.active || !v.videoWidth) return;
  const r = $('stage').getBoundingClientRect();
  const dz = digitalZoom();
  // 화면 위치 → 영상 안 위치(0~1): 디지털 줌(가운데 기준 확대)과 object-fit: contain 여백을 되돌린다
  const x = r.width / 2 + (cx - r.left - r.width / 2) / dz;
  const y = r.height / 2 + (cy - r.top - r.height / 2) / dz;
  const scale = Math.min(r.width / v.videoWidth, r.height / v.videoHeight);
  const vw = v.videoWidth * scale;
  const vh = v.videoHeight * scale;
  let nx = (x - (r.width - vw) / 2) / vw;
  const ny = (y - (r.height - vh) / 2) / vh;
  if (nx < 0 || nx > 1 || ny < 0 || ny > 1) return;
  if (camera.facing === 'user') nx = 1 - nx; // 전면은 미리보기가 좌우 반전
  const ring = $('focusRing');
  ring.hidden = true;
  ring.classList.remove('fail');
  void ring.offsetWidth;
  Object.assign(ring.style, { left: cx - r.left + 'px', top: cy - r.top + 'px' });
  ring.hidden = false;
  const ok = await camera.focusAt(nx, ny);
  ring.classList.toggle('fail', !ok);
  if (!ok && !focusWarned) {
    focusWarned = true;
    toast('이 카메라는 눌러서 초점 맞추기를 지원하지 않습니다 (자동 초점으로 찍힙니다).', 3000);
  }
}
$('focusRing').addEventListener('animationend', () => ($('focusRing').hidden = true));

{
  const stage = $('stage');
  const pts = new Map();
  let pinch = null;
  let tap = null;
  const dist = () => {
    const [a, b] = [...pts.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  };
  stage.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button, .fallback')) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 1) tap = { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now() };
    else {
      tap = null;
      if (pts.size === 2) pinch = { d: dist(), z: zoom };
    }
  });
  stage.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (tap && Math.hypot(e.clientX - tap.x, e.clientY - tap.y) > 12) tap = null;
    if (pinch && pts.size >= 2) {
      const d = dist();
      if (pinch.d > 0) setZoom(pinch.z * (d / pinch.d));
    }
  });
  const end = (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.delete(e.pointerId);
    if (e.type === 'pointerup' && tap && tap.id === e.pointerId && performance.now() - tap.t < 600) focusTap(e.clientX, e.clientY);
    tap = null;
    if (pts.size < 2) pinch = null;
  };
  stage.addEventListener('pointerup', end);
  stage.addEventListener('pointercancel', end);
}

/* ── 수평 표시 ──────────────────────────────────── */
// 가속도(중력) 방향으로 기울기를 잰다. 세워 들면 수평선, 눕혀 들면(바닥·천장 촬영) 기포
let motionOn = false;
let gravity = null;
let levelRaf = 0;
function onMotion(e) {
  const g = e.accelerationIncludingGravity;
  if (!g || g.x == null || g.y == null) return;
  gravity = { x: g.x, y: g.y, z: g.z || 0 };
  if (!levelRaf) levelRaf = requestAnimationFrame(drawLevel);
}
function screenAngle() {
  const o = screen.orientation;
  return (o && typeof o.angle === 'number' ? o.angle : window.orientation) || 0;
}
function drawLevel() {
  levelRaf = 0;
  const line = $('levelLine');
  const bubble = $('levelBubble');
  if (!s.levelOn || !gravity) {
    line.hidden = bubble.hidden = true;
    return;
  }
  const { x, y, z } = gravity;
  const a = screenAngle();
  if (Math.hypot(x, y) >= Math.abs(z)) {
    let roll = (Math.atan2(x, y) * 180) / Math.PI - a;
    roll = ((((roll + 180) % 360) + 360) % 360) - 180;
    line.hidden = false;
    bubble.hidden = true;
    line.style.setProperty('--roll', roll.toFixed(1) + 'deg');
    line.classList.toggle('ok', Math.abs(roll) < 1);
    line.dataset.roll = roll.toFixed(1);
  } else {
    // 기포는 높은 쪽으로 간다 → 수평 성분의 반대, 화면 회전만큼 돌려서
    const rad = (a * Math.PI) / 180;
    const ux = -x;
    const uy = -y;
    const sx = ux * Math.cos(rad) - uy * Math.sin(rad);
    const sy = ux * Math.sin(rad) + uy * Math.cos(rad);
    const k = 21 / 4.9; // 약 30° 기울면 가장자리
    const clamp = (v) => Math.max(-21, Math.min(21, v));
    line.hidden = true;
    bubble.hidden = false;
    bubble.style.setProperty('--bx', clamp(sx * k).toFixed(1) + 'px');
    bubble.style.setProperty('--by', clamp(-sy * k).toFixed(1) + 'px');
    bubble.classList.toggle('ok', Math.hypot(x, y) < 0.17); // 약 1°
  }
}
function syncLevel() {
  if (s.levelOn && !motionOn) {
    window.addEventListener('devicemotion', onMotion);
    motionOn = true;
  } else if (!s.levelOn && motionOn) {
    window.removeEventListener('devicemotion', onMotion);
    motionOn = false;
    gravity = null;
  }
  drawLevel();
  renderOverlay();
}

/* ── 시작 ───────────────────────────────────────── */
$('appVersion').textContent = $('appVersionTop').textContent = 'v' + APP_VERSION;
fillSettingsUI();
updateNext();
refreshListBadge().then(async (items) => {
  if (items[0] && items[0].thumb) setLastThumb(items[0].thumb);
});
requestPersist();
syncLevel();
startCamera();

// 새 버전 배포 → 서비스워커가 바뀌면 화면을 한 번 새로 읽어 바로 새 버전을 쓴다.
// 홈 화면 앱은 껐다 켜도 백그라운드에서 그대로 돌아오므로, 다시 볼 때마다 업데이트를 확인한다.
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  const hadController = !!navigator.serviceWorker.controller;
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', async () => {
    if (!hadController || reloading) return; // 처음 설치일 때는 새로고침 불필요
    reloading = true;
    while (busy) await sleep(200); // 촬영·저장 중이면 끝난 뒤에
    location.reload();
  });
  navigator.serviceWorker
    .register('sw.js', { updateViaCache: 'none' })
    .then((reg) => {
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) reg.update().catch(() => {});
      });
    })
    .catch((e) => console.warn('서비스워커 등록 실패', e));
}
