// 카메라 스트림 시작/전환/캡처.

export class Camera {
  constructor(video) {
    this.video = video;
    this.stream = null;
    this.facing = 'environment';
  }

  get active() {
    return !!this.stream;
  }

  async start(facing = this.facing) {
    this.stop();
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw Object.assign(new Error('이 브라우저는 카메라를 지원하지 않습니다.'), { name: 'NotSupportedError' });
    }
    this.facing = facing;
    // 4:3에서 가능한 가장 큰 해상도를 요청한다 (기기가 지원하는 값으로 맞춰지고,
    // 다른 비율이 오면 저장할 때 가운데를 4:3으로 자른다 — crop43)
    const video = {
      facingMode: { ideal: facing },
      width: { ideal: 4096 },
      height: { ideal: 3072 },
      aspectRatio: { ideal: 4 / 3 },
    };
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
    } catch (e) {
      if (e.name === 'OverconstrainedError') {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: facing }, audio: false });
      } else {
        throw e;
      }
    }
    this.stream = stream;
    this.video.srcObject = stream;
    this.video.classList.toggle('mirror', facing === 'user');
    await this.video.play().catch(() => {});
    if (!this.video.videoWidth) {
      await new Promise((res) => this.video.addEventListener('loadedmetadata', res, { once: true }));
    }
  }

  get track() {
    return this.stream ? this.stream.getVideoTracks()[0] : null;
  }

  // 플래시(손전등) 지원 여부 — 안드로이드 크롬 후면 카메라에서 주로 지원
  get torchSupported() {
    const t = this.track;
    try {
      return !!(t && t.getCapabilities && t.getCapabilities().torch);
    } catch (e) {
      return false;
    }
  }

  async setTorch(on) {
    if (!this.torchSupported) return false;
    try {
      await this.track.applyConstraints({ advanced: [{ torch: !!on }] });
      return true;
    } catch (e) {
      console.warn('플래시 제어 실패', e);
      return false;
    }
  }

  // 고화질 촬영(takePhoto)의 최대 크기 (센서 방향 그대로). 모르면 null
  async photoMax() {
    if (!this.track || !('ImageCapture' in window)) return null;
    try {
      const c = await new ImageCapture(this.track).getPhotoCapabilities();
      const w = c.imageWidth && c.imageWidth.max;
      const h = c.imageHeight && c.imageHeight.max;
      return w && h ? { width: w, height: h } : null;
    } catch (e) {
      return null;
    }
  }

  // 고화질 촬영으로 찍힐 크기 — 미리보기와 같은 가로/세로 방향으로
  async photoSize() {
    const p = await this.photoMax();
    if (!p) return null;
    const v = this.video;
    const turned = v.videoWidth && (v.videoHeight > v.videoWidth) !== (p.height > p.width);
    return turned ? { width: p.height, height: p.width } : p;
  }

  // 고화질이 미리보기 영상보다 실제로 큰가 (작거나 같으면 쓸 이유가 없다)
  async hiResHelps() {
    const p = await this.photoMax();
    return !!p && p.width * p.height > this.video.videoWidth * this.video.videoHeight;
  }

  stop() {
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
    this.video.srcObject = null;
  }

  async switchFacing() {
    await this.start(this.facing === 'user' ? 'environment' : 'user');
    return this.facing;
  }

  // 현재 화면을 캡처해 { source, width, height } 를 돌려준다.
  // hiRes면 ImageCapture.takePhoto로 원본 해상도를 시도하고, 실패하면 비디오 프레임으로 대신한다.
  async capture(hiRes) {
    const v = this.video;
    if (!this.stream || !v.videoWidth) throw new Error('카메라가 준비되지 않았습니다.');
    // 고화질이 영상보다 작은 기기(일부 기기·가짜 카메라)는 영상 프레임이 더 낫다
    const max = hiRes ? await this.photoMax() : null;
    if (max && max.width * max.height > v.videoWidth * v.videoHeight) {
      try {
        const track = this.stream.getVideoTracks()[0];
        // 최대 크기를 달라고 명시 (기본값은 기기마다 작게 나오기도 함)
        const ic = new ImageCapture(track);
        const blob = await ic.takePhoto({ imageWidth: max.width, imageHeight: max.height }).catch(() => ic.takePhoto());
        let bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
        // 일부 기기는 센서 방향 그대로 돌려준다 → 미리보기와 가로/세로가 다르면 돌려 맞춘다
        const vPortrait = v.videoHeight > v.videoWidth;
        const pPortrait = bmp.height > bmp.width;
        if (vPortrait !== pPortrait) bmp = rotate90(bmp, this.facing === 'user' ? -1 : 1);
        return { source: bmp, width: bmp.width, height: bmp.height, hiRes: true };
      } catch (e) {
        console.warn('takePhoto 실패, 비디오 프레임으로 대신함', e);
      }
    }
    const c = document.createElement('canvas');
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    c.getContext('2d').drawImage(v, 0, 0);
    return { source: c, width: c.width, height: c.height, hiRes: false };
  }
}

// 가운데를 4:3(세로 사진이면 3:4)으로 자르는 영역 { x, y, w, h }
export function crop43(width, height) {
  const ratio = width >= height ? 4 / 3 : 3 / 4;
  if (Math.abs(width / height - ratio) < 0.005) return { x: 0, y: 0, w: width, h: height };
  if (width / height > ratio) {
    const w = Math.round(height * ratio);
    return { x: Math.round((width - w) / 2), y: 0, w, h: height };
  }
  const h = Math.round(width / ratio);
  return { x: 0, y: Math.round((height - h) / 2), w: width, h };
}

function rotate90(src, dir) {
  const c = document.createElement('canvas');
  c.width = src.height;
  c.height = src.width;
  const ctx = c.getContext('2d');
  ctx.translate(c.width / 2, c.height / 2);
  ctx.rotate((dir * Math.PI) / 2);
  ctx.drawImage(src, -src.width / 2, -src.height / 2);
  return c;
}

export function cameraErrorMessage(e) {
  switch (e && e.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return '카메라 권한이 거부되었습니다. 주소창 왼쪽 자물쇠 → 권한에서 카메라를 허용해 주세요.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return '사용할 수 있는 카메라를 찾지 못했습니다.';
    case 'NotReadableError':
      return '다른 앱이 카메라를 사용 중입니다. 다른 앱을 닫고 다시 시도해 주세요.';
    case 'NotSupportedError':
      return '이 브라우저는 카메라를 지원하지 않습니다. 크롬에서 열어 주세요.';
    default:
      return '카메라를 시작하지 못했습니다: ' + ((e && e.message) || e);
  }
}
