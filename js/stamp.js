// canvas에 번호·날짜 스탬프를 그린다. 미리보기 오버레이와 저장 이미지가 같은 함수를 쓴다.
// 크기·여백은 모두 사진 짧은 변 기준 비율이라 해상도가 달라도 모양이 같다.

const DATE_RATIO = 0.6; // 아래 줄 날짜 글자 크기 (번호 대비)

function hexToRgba(hex, alpha) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  const v = m ? parseInt(m[1], 16) : 0;
  return `rgba(${(v >> 16) & 255},${(v >> 8) & 255},${v & 255},${alpha})`;
}

export function drawStamp(ctx, w, h, texts, s) {
  const short = Math.min(w, h);
  let fontPx = Math.max(4, (short * s.size) / 100);
  const margin = (short * s.margin) / 100;
  const weight = s.bold ? 'bold' : 'normal';
  const family = 'system-ui, "Noto Sans KR", "Malgun Gothic", sans-serif';

  // 줄 구성 (번호 표시를 끄면 numberText가 빈 문자열 → 날짜만, 날짜 크기는 그대로)
  const lines = [];
  if (texts.numberText && texts.dateText && s.dateLayout === 'inline') {
    lines.push({ text: `${texts.numberText}  ${texts.dateText}`, px: fontPx });
  } else {
    if (texts.numberText) lines.push({ text: texts.numberText, px: fontPx });
    if (texts.dateText) lines.push({ text: texts.dateText, px: fontPx * DATE_RATIO });
  }
  if (!lines.length) return;
  fontPx = Math.max(...lines.map((l) => l.px)); // 여백·외곽선·박스 크기의 기준

  const outlinePx = s.outline ? fontPx * s.outlineWidth * 0.035 : 0;
  const lineGap = fontPx * 0.15;
  ctx.save();
  ctx.textBaseline = 'alphabetic';
  for (const ln of lines) {
    ctx.font = `${weight} ${ln.px}px ${family}`;
    const m = ctx.measureText(ln.text);
    ln.width = m.width;
    ln.ascent = ln.px * 0.8;
    ln.descent = ln.px * 0.22;
  }
  const blockW = Math.max(...lines.map((l) => l.width)) + outlinePx;
  const blockH =
    lines.reduce((a, l) => a + l.ascent + l.descent, 0) + lineGap * (lines.length - 1) + outlinePx;
  const pad = s.box ? fontPx * 0.3 : 0;

  // 9칸 격자 위치 → 블록(배경 박스 포함) 좌상단
  const col = s.position[1]; // l c r
  const row = s.position[0]; // t m b
  const outerW = blockW + pad * 2;
  const outerH = blockH + pad * 2;
  const x0 = col === 'l' ? margin : col === 'r' ? w - margin - outerW : (w - outerW) / 2;
  const y0 = row === 't' ? margin : row === 'b' ? h - margin - outerH : (h - outerH) / 2;

  if (s.box) {
    ctx.fillStyle = hexToRgba(s.boxColor, s.boxOpacity / 100);
    const r = fontPx * 0.15;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x0, y0, outerW, outerH, r);
    else ctx.rect(x0, y0, outerW, outerH);
    ctx.fill();
  }

  ctx.textAlign = col === 'l' ? 'left' : col === 'r' ? 'right' : 'center';
  const tx =
    col === 'l' ? x0 + pad + outlinePx / 2 : col === 'r' ? x0 + outerW - pad - outlinePx / 2 : x0 + outerW / 2;
  let y = y0 + pad + outlinePx / 2;
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;
  for (const ln of lines) {
    y += ln.ascent;
    ctx.font = `${weight} ${ln.px}px ${family}`;
    if (outlinePx > 0) {
      ctx.strokeStyle = s.outlineColor;
      ctx.lineWidth = outlinePx * (ln.px / fontPx);
      ctx.strokeText(ln.text, tx, y);
    }
    ctx.fillStyle = s.color;
    ctx.fillText(ln.text, tx, y);
    y += ln.descent + lineGap;
  }
  ctx.restore();
}
