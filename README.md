# 번호 스탬프 카메라

찍을 때마다 순차 번호(+날짜/시간)를 사진에 찍어 저장하는 웹앱(PWA). 안드로이드 크롬 기준.

- 사용: https://yeop9701.github.io/stamp-camera/ → 크롬 메뉴 "홈 화면에 추가"
- 설계/결정 사항: [DESIGN.md](DESIGN.md)

## 개발

```
node tests/serve.mjs 8123          # http://localhost:8123/
chrome --headless=new --remote-debugging-port=9222 --user-data-dir=<임시폴더> \
       --use-fake-device-for-media-stream --use-fake-ui-for-media-stream about:blank
node tests/test-app.mjs            # 전체 흐름 검사 (가짜 카메라)
node tests/test-update.mjs [커밋]  # 예전 버전 설치 → 지금 작업본 배포 시 업데이트 반영 검사
```

앱 파일을 바꾸면 `sw.js`의 `VERSION`을 올린다 (휴대폰에 캐시된 옛 버전 갱신).
