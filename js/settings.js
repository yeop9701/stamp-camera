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
  // 같은 번호로 여러 장 (0012-1, 0012-2 …)
  sameOn: false,       // 켜져 있으면 번호는 그대로, 뒤 번호(sub)만 오른다
  sub: 1,              // 다음에 찍힐 뒤 번호
  subSep: '-',         // 번호와 뒤 번호 사이 기호
  // 메모 (위치·부재명)
  memo: '',
  memoOn: false,       // 사진에 메모 표시 (꺼도 파일명 {memo}에는 들어감)
  memoRecent: [],      // 최근 메모 (최대 12개)
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
  fileName: '{date}_{no}_{memo}', // 메모가 비면 {memo}와 그 앞 _ 는 빠진다
  quality: 92,
  // 카메라
  facing: 'environment',
  hiRes: false,        // ImageCapture.takePhoto 사용 (실험)
  flashMode: 'off',    // off | shot(촬영할 때만) | on(계속 켜기)
  // 화면 보조 (사진에는 안 찍힘)
  gridOn: false,       // 3×3 격자선
  levelOn: false,      // 수평 표시
  rev: 4,              // 설정 판 번호 (아래 REV_MIGRATIONS)
};

// 예전 기본값을 그대로 쓰던 설정은 새 기본값으로 옮긴다 (직접 바꾼 값은 유지)
const OLD_DEFAULTS = { fileName: ['{no}_{date}_{time}'] };
// 판이 오를 때 한 번만 옮기는 값 { 판: { 키: { 옛값: 새값 } } }
//  rev 2: "사진에 표시" 기본값을 껐다 → 예전 판에서 켜진 채 저장된 것도 끈다
//  rev 3: 자릿수 기본값 3 → 4
//  rev 4: 파일명 목록에 메모가 들어감 → 목록에서 고른 옛 규칙은 같은 순서 + _{memo} (메모가 비면 파일명은 그대로)
const REV_MIGRATIONS = {
  2: { numberOn: { true: false }, dateOn: { true: false } },
  3: { pad: { 3: 4 } },
  4: {
    fileName: {
      '{date}_{no}': '{date}_{no}_{memo}',
      '{no}_{date}': '{no}_{memo}_{date}',
      '{date}_{time}_{no}': '{date}_{time}_{no}_{memo}',
      '{no}': '{no}_{memo}',
    },
  },
};

const sameType = (a, b) => (Array.isArray(b) ? Array.isArray(a) : typeof a === typeof b);

export function loadSettings() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS, memoRecent: [] };
    const saved = JSON.parse(raw);
    if (!saved || typeof saved !== 'object') return { ...DEFAULTS, memoRecent: [] };
    // 모르는 키는 버리고, 없는 키는 기본값으로 채운다 (설정 구조가 바뀌어도 안전)
    const out = { ...DEFAULTS, memoRecent: [] };
    for (const k of Object.keys(DEFAULTS)) {
      if (k in saved && sameType(saved[k], DEFAULTS[k])) out[k] = saved[k];
    }
    out.memoRecent = out.memoRecent.filter((m) => typeof m === 'string' && m).slice(0, 12);
    for (const [k, olds] of Object.entries(OLD_DEFAULTS)) {
      if (olds.includes(out[k])) out[k] = DEFAULTS[k];
    }
    const savedRev = typeof saved.rev === 'number' ? saved.rev : 1;
    for (const [rev, map] of Object.entries(REV_MIGRATIONS)) {
      if (savedRev >= Number(rev)) continue;
      for (const [k, pairs] of Object.entries(map)) {
        const key = String(out[k]);
        if (Object.prototype.hasOwnProperty.call(pairs, key)) out[k] = pairs[key];
      }
    }
    if (!(out.sub >= 1)) out.sub = 1;
    out.rev = DEFAULTS.rev;
    return out;
  } catch (e) {
    return { ...DEFAULTS, memoRecent: [] };
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
