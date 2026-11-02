// 촬영 목록을 엑셀에서 바로 열리는 CSV로 (UTF-8 BOM, 한글 안 깨짐)
import { formatDate } from './counter.js';

const cell = (v) => {
  const t = v == null ? '' : String(v);
  return /[",\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
};

// items: 찍은 순서대로, names: ZIP 안 파일명과 같은 이름(겹치면 "이름 (2).jpg")
export function shotsCsv(items, names) {
  const rows = [['순서', '번호', '메모', '촬영일', '촬영시각', '파일명', '가로', '세로']];
  items.forEach((it, n) => {
    const d = new Date(it.createdAt);
    rows.push([n + 1, it.numberText, it.memo || '', formatDate(d, 'YYYY-MM-DD'), formatDate(d, 'HH:mm:ss'),
      names[n], it.width || '', it.height || '']);
  });
  return new Blob(['\ufeff' + rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n'], { type: 'text/csv;charset=utf-8' });
}
