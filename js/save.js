// 다운로드 / 공유.

export function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

export function canShareFiles() {
  try {
    const f = new File([new Blob(['x'], { type: 'image/jpeg' })], 'x.jpg', { type: 'image/jpeg' });
    return !!(navigator.canShare && navigator.canShare({ files: [f] }));
  } catch (e) {
    return false;
  }
}

// 공유 시트를 연다. 사용자가 취소하면 false.
export function shareBlob(blob, name) {
  return shareFiles([{ blob, name }]);
}

// 여러 장을 한 번에 공유 (items: [{ blob, name }])
export async function shareFiles(items) {
  const files = items.map(({ blob, name }) => new File([blob], name, { type: blob.type || 'image/jpeg' }));
  if (!(navigator.canShare && navigator.canShare({ files }))) {
    throw new Error('이 브라우저는 파일 공유를 지원하지 않습니다.');
  }
  try {
    await navigator.share({ files });
    return true;
  } catch (e) {
    if (e.name === 'AbortError') return false;
    throw e;
  }
}

export function canvasToBlob(canvas, quality) {
  return new Promise((res, rej) =>
    canvas.toBlob((b) => (b ? res(b) : rej(new Error('이미지를 만들지 못했습니다.'))), 'image/jpeg', quality)
  );
}
