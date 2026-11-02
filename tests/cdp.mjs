// 의존성 없는 최소 CDP 클라이언트 (Node 22+ 내장 WebSocket 사용)
import { setTimeout as sleep } from 'node:timers/promises';

export async function connect(port = 9222) {
  let targets;
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/list`);
      targets = await r.json();
      if (targets.some(t => t.type === 'page')) break;
    } catch (e) { /* 아직 안 떴음 */ }
    await sleep(250);
  }
  const page = targets.find(t => t.type === 'page');
  if (!page) throw new Error('page target not found');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let id = 0;
  const pending = new Map();
  const events = [];
  const dialogs = [];
  // 이 앱은 beforeunload(미저장 변경사항 확인)와 confirm()을 쓴다. CDP로 몰면 그 대화상자가
  // 뜬 채로 페이지 전체가 멈추고 Runtime.evaluate가 영영 응답하지 않는다 — 반드시 받아서 처리해야 한다.
  // dialogAnswer로 accept/dismiss를 바꿔가며 "확인/취소" 두 갈래를 모두 시험할 수 있다.
  const state = { dialogAnswer: true };
  ws.onmessage = ev => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
    } else if (msg.method === 'Page.javascriptDialogOpening') {
      dialogs.push({ type: msg.params.type, message: msg.params.message, answered: state.dialogAnswer });
      ws.send(JSON.stringify({ id: ++id, method: 'Page.handleJavaScriptDialog', params: { accept: state.dialogAnswer } }));
    } else if (msg.method) {
      events.push(msg);
    }
  };
  const send = (method, params = {}) => new Promise((res, rej) => {
    const mid = ++id;
    pending.set(mid, { res, rej });
    ws.send(JSON.stringify({ id: mid, method, params }));
    setTimeout(() => {
      if (pending.has(mid)) { pending.delete(mid); rej(new Error('CDP timeout: ' + method)); }
    }, 20000);
  });

  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: true, userGesture: true,
    });
    if (r.exceptionDetails) {
      throw new Error('JS ERROR: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    }
    return r.result.value;
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Log.enable');
  return {
    send, evaluate, events, ws, dialogs, state,
    setDialogAnswer: v => { state.dialogAnswer = v; },
    close: () => ws.close(),
  };
}

// 실제 마우스 입력을 브라우저 입력 파이프라인으로 흘려보낸다(합성 이벤트가 아니라 진짜 입력).
export async function drag(cdp, path, { steps = 12, button = 'left', modifiers = 0 } = {}) {
  const [start, ...rest] = path;
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: start.x, y: start.y, button, buttons: 1, clickCount: 1, modifiers });
  let prev = start;
  for (const pt of rest) {
    for (let i = 1; i <= steps; i++) {
      const x = prev.x + (pt.x - prev.x) * (i / steps);
      const y = prev.y + (pt.y - prev.y) * (i / steps);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button, buttons: 1, modifiers });
    }
    prev = pt;
  }
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: prev.x, y: prev.y, button, buttons: 0, clickCount: 1, modifiers });
}

export async function click(cdp, x, y) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
}

export async function typeText(cdp, text) {
  for (const ch of text) {
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, unmodifiedText: ch });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', text: ch, unmodifiedText: ch });
  }
}

export async function key(cdp, { code, keyStr, windowsVirtualKeyCode, text }) {
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', code, key: keyStr, windowsVirtualKeyCode, text });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', code, key: keyStr, windowsVirtualKeyCode });
}

export async function shot(cdp, file) {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const fs = await import('node:fs');
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
  return file;
}

// 스크립트가 끝나면 WebSocket이 이벤트 루프를 붙잡아 node가 종료되지 않는다.
// 또 Chrome은 한 page 타깃에 디버거 연결을 하나만 허용하므로, 반드시 닫고 끝내야 다음 테스트가 붙는다.
export function finish(cdp, code = 0) {
  try { cdp.ws.close(); } catch (e) {}
  setTimeout(() => process.exit(code), 150);
}
