// 번호 계산과 표시 형식, 날짜 형식, 파일명 규칙.

export function formatNumber(n, s) {
  const neg = n < 0;
  let body = String(Math.abs(n));
  if (s.pad > 0) body = body.padStart(s.pad, '0');
  return s.prefix + (neg ? '-' : '') + body + s.suffix;
}

export function nextValue(n, s) {
  return n + s.step;
}

const p2 = (v) => String(v).padStart(2, '0');

export const DATE_FORMATS = [
  'YYYY-MM-DD HH:mm',
  'YYYY-MM-DD HH:mm:ss',
  'YYYY-MM-DD',
  'YYYY.MM.DD HH:mm',
  'YY.MM.DD HH:mm',
  'YY.MM.DD',
  'HH:mm:ss',
  'HH:mm',
];

export function formatDate(d, fmt) {
  const map = {
    YYYY: String(d.getFullYear()),
    YY: String(d.getFullYear()).slice(2),
    MM: p2(d.getMonth() + 1),
    DD: p2(d.getDate()),
    HH: p2(d.getHours()),
    mm: p2(d.getMinutes()),
    ss: p2(d.getSeconds()),
  };
  return fmt.replace(/YYYY|YY|MM|DD|HH|mm|ss/g, (t) => map[t]);
}

// 파일명 규칙: {no}/{번호} 번호, {date}/{날짜} 20261029, {time}/{시간} 143012
export function buildFileName(pattern, numberText, d) {
  const date = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}`;
  const time = `${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
  let name = (pattern || '{no}')
    .replace(/\{(no|번호)\}/g, numberText)
    .replace(/\{(date|날짜)\}/g, date)
    .replace(/\{(time|시간)\}/g, time);
  name = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim();
  return (name || 'photo') + '.jpg';
}
