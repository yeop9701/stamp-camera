// 설정값: localStorage에 JSON 하나로 저장한다. 사진은 넣지 않는다.
const KEY = 'stampcam.settings.v1';

export const DEFAULTS = {
  // 번호
  numberOn: false,     // 사진에 번호 표시 (꺼도 번호는 파일명에 쓰이고 계속 올라감)
  current: 1,          // 다음에 찍힐 번호
  start: 1,
  step: 1,
  pad: 4,              // 자릿수 0 채우기 (0이면 안 채움)
  prefix: '',
  suffix: '',
  // 위치
  position: 'tl',      // tl tc tr ml mc mr bl bc br
  margin: 3,           // 사진 짧은 변 기준 %
  // 글자
  size: 8,             // 사진 짧은 변 기준 %
  bold: true,
  color: '#ffffff',
  // 테두리
  outline: true,
  outlineWidth: 3,     // 1~10 단계
  outlineColor: '#000000',
  box: false,
  boxColor: '#000000',
  boxOpacity: 50,      // %
  // 날짜/시간
  dateOn: false,       // 사진에 날짜/시간 표시
  dateFormat: 'YYYY-MM-DD HH:mm',
  dateLayout: 'below', // below | inline
  // 저장
  saveMode: 'download',  // download | share | list
  keepInList: true,
  fileName: '{date}_{no}',
  quality: 92,
  // 카메라
  facing: 'environment',
  hiRes: false,        // ImageCapture.takePhoto 사용 (실험)
  flashMode: 'off',    // off | shot(촬영할 때만) | on(계속 켜기)
  rev: 3,              // 설정 판 번호 (아래 REV_MIGRATIONS)
};

// 예전 기본값을 그대로 쓰던 설정은 새 기본값으로 옮긴다 (직접 바꾼 값은 유지)
const OLD_DEFAULTS = { fileName: ['{no}_{date}_{time}'] };
// 판이 오를 때 한 번만 옮기는 값: rev 2에서 "사진에 표시" 기본값을 껐다 → 예전 판에서 켜진 채 저장된 것도 끈다
// rev 3: 자릿수 기본값 3 → 4 (옛 기본값 3 그대로 쓰던 설정만 4로)
const REV_MIGRATIONS = { 2: { numberOn: [true], dateOn: [true] }, 3: { pad: [3] } };

export function loadSettings() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    const saved = JSON.parse(raw);
    if (!saved || typeof saved !== 'object') return { ...DEFAULTS };
    // 모르는 키는 버리고, 없는 키는 기본값으로 채운다 (설정 구조가 바뀌어도 안전)
    const out = { ...DEFAULTS };
    for (const k of Object.keys(DEFAULTS)) {
      if (k in saved && typeof saved[k] === typeof DEFAULTS[k]) out[k] = saved[k];
    }
    for (const [k, olds] of Object.entries(OLD_DEFAULTS)) {
      if (olds.includes(out[k])) out[k] = DEFAULTS[k];
    }
    const savedRev = typeof saved.rev === 'number' ? saved.rev : 1;
    for (const [rev, map] of Object.entries(REV_MIGRATIONS)) {
      if (savedRev >= Number(rev)) continue;
      for (const [k, olds] of Object.entries(map)) if (olds.includes(out[k])) out[k] = DEFAULTS[k];
    }
    out.rev = DEFAULTS.rev;
    return out;
  } catch (e) {
    return { ...DEFAULTS };
  }
}

export function saveSettings(s) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
    return true;
  } catch (e) {
    return false;
  }
}
