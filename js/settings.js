// 설정값: localStorage에 JSON 하나로 저장한다. 사진은 넣지 않는다.
const KEY = 'stampcam.settings.v1';

export const DEFAULTS = {
  // 번호
  numberOn: true,      // 사진에 번호 표시 (꺼도 번호는 파일명에 쓰이고 계속 올라감)
  current: 1,          // 다음에 찍힐 번호
  start: 1,
  step: 1,
  pad: 3,              // 자릿수 0 채우기 (0이면 안 채움)
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
  dateOn: true,
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
};

// 예전 기본값을 그대로 쓰던 설정은 새 기본값으로 옮긴다 (직접 바꾼 값은 유지)
const OLD_DEFAULTS = { fileName: ['{no}_{date}_{time}'] };

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
