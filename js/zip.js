// 무압축(STORE) ZIP 만들기. JPEG는 이미 압축돼 있어서 압축해도 거의 줄지 않는다.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosTime(d) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

// files: [{ name, blob, date }]
export async function makeZip(files) {
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;

  for (const f of files) {
    const data = new Uint8Array(await f.blob.arrayBuffer());
    const name = enc.encode(f.name);
    const crc = crc32(data);
    const { time, date } = dosTime(f.date || new Date());

    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);
    lh.setUint16(4, 20, true);
    lh.setUint16(6, 0x0800, true); // 파일명 UTF-8
    lh.setUint16(8, 0, true); // STORE
    lh.setUint16(10, time, true);
    lh.setUint16(12, date, true);
    lh.setUint32(14, crc, true);
    lh.setUint32(18, data.length, true);
    lh.setUint32(22, data.length, true);
    lh.setUint16(26, name.length, true);
    lh.setUint16(28, 0, true);
    parts.push(lh.buffer, name, data);

    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true);
    ch.setUint16(4, 20, true);
    ch.setUint16(6, 20, true);
    ch.setUint16(8, 0x0800, true);
    ch.setUint16(10, 0, true);
    ch.setUint16(12, time, true);
    ch.setUint16(14, date, true);
    ch.setUint32(16, crc, true);
    ch.setUint32(20, data.length, true);
    ch.setUint32(24, data.length, true);
    ch.setUint16(28, name.length, true);
    ch.setUint32(42, offset, true);
    central.push(ch.buffer, name);

    offset += 30 + name.length + data.length;
  }

  const centralSize = central.reduce((a, p) => a + p.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);

  return new Blob([...parts, ...central, end.buffer], { type: 'application/zip' });
}

// 같은 이름이 겹치면 "이름 (2).jpg" 처럼 바꾼다
export function uniqueNames(names) {
  const seen = new Map();
  return names.map((n) => {
    const key = n.toLowerCase();
    if (!seen.has(key)) {
      seen.set(key, 1);
      return n;
    }
    let i = seen.get(key) + 1;
    const dot = n.lastIndexOf('.');
    const base = dot > 0 ? n.slice(0, dot) : n;
    const ext = dot > 0 ? n.slice(dot) : '';
    let cand;
    do {
      cand = `${base} (${i})${ext}`;
      i++;
    } while (seen.has(cand.toLowerCase()));
    seen.set(key, i - 1);
    seen.set(cand.toLowerCase(), 1);
    return cand;
  });
}
