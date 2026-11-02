# 번호 스탬프 카메라

찍을 때마다 순차 번호(+날짜/시간)를 사진에 찍어 저장하는 웹앱(PWA). 안드로이드 크롬 기준.

- 사용: https://yeop9701.github.io/stamp-camera/ → 크롬 메뉴 "앱 설치" (설치해서 열면 주소창 없음)
- 저장소: https://github.com/yeop9701/stamp-camera (main에 푸시하면 1~2분 뒤 자동 배포)
- 설계/결정 사항, 버전별 변경 내역: [DESIGN.md](DESIGN.md) 6·7절

## 현재 상태 (2026-11-02, v1.7.0)

- 기능: 4:3 고정 촬영(미리보기에 잘릴 부분 어둡게), 번호(기본 4자리)·날짜 스탬프(기본은 사진에 표시 안 함), 파일명 `날짜_번호`,
  플래시(끔/촬영할 때만/계속), 되돌리기, 촬영 목록(여러 장 선택 → 다운로드·ZIP·공유·삭제), 고화질 촬영(실험),
  가로/세로 화면, 오프라인 실행, 자동 업데이트.
  v1.7.0: 같은 번호로 여러 장(0012-2), 메모(위치·부재명, 파일명 {메모}), 줌·눌러서 초점, 목록 CSV(ZIP 안에도), 격자선·수평 표시(기본 끔).
- 검사: `tests/test-app.mjs` 166개, `tests/test-update.mjs` 7개 모두 통과 (로컬·배포본).
- **실제 휴대폰 확인 대기** — 아래 "다음에 확인할 것".

### 다음에 확인할 것 / 남은 일

- [ ] 휴대폰에서 버전 v1.7.0 표시 확인 (설정 제목 옆)
- [ ] 가로 화면(v1.6.0에서 큰 화면도 셔터 오른쪽으로): 설치된 앱이 가로로 도는지 (안 돌면 폰 자동 회전 확인 → 앱 다시 설치). 가로 배치에서 가리는 버튼 없는지
- [ ] 고화질 촬영 켰을 때 "지금 저장 해상도"가 얼마로 나오는지 → 그 폰에서 고화질이 쓸모 있는지 판단
- [ ] 플래시(손전등) 동작, 여러 장 다운로드 시 크롬 "여러 파일 다운로드" 허용 안내가 필요한지
- [ ] v1.7.0 휴대폰 확인: 줌 버튼이 카메라 줌(부드러움)인지 디지털(화질 저하)인지, 고화질 촬영 + 카메라 줌 때 사진이 확대돼 찍히는지,
      눌러서 초점이 실제로 맞는지, 수평선 방향(오른쪽으로 기울이면 선이 왼쪽으로 기울어야 함)·가로 화면에서도 맞는지, 엑셀에서 CSV 한글
- [ ] 나중에: 현장조사 도구 허브에 합치기 (그때도 상대경로 그대로라 하위 폴더로 옮기기만 하면 됨)

## 고칠 곳 찾기

| 바꾸고 싶은 것 | 파일 |
|---|---|
| 화면 배치·버튼 | `index.html`, `css/style.css` (가로 화면은 맨 아래 `@media (orientation: landscape)`, 높이 조건 없음) |
| 설정 항목·기본값 | `js/settings.js` `DEFAULTS` + `index.html` 설정 패널 + `js/app.js` "설정 패널" 절의 `fields` 목록 |
| 스탬프 모양(글자·테두리·위치) | `js/stamp.js` `drawStamp` (미리보기·저장 공용, 줄: 번호/메모/날짜) |
| 같은 번호·메모·줌·초점·수평 | `js/app.js` 끝쪽 "같은 번호로 여러 장"~"수평 표시" 절, 줌·초점 하드웨어는 `js/camera.js` (`zoomRange`, `setZoom`, `focusAt`, `zoomCrop`) |
| 목록 CSV | `js/csv.js` |
| 번호 형식·파일명 규칙·날짜 형식 | `js/counter.js` |
| 카메라 해상도·4:3 자르기·고화질·플래시 | `js/camera.js` (`start`, `crop43`, `capture`, `setTorch`) |
| 촬영 → 저장 흐름 | `js/app.js` "촬영 → 스탬프 → 저장" 절 (`shoot`, `storeStamped`) |
| 촬영 목록·선택·ZIP | `js/app.js` "촬영 목록" 절, `js/storage.js`(IndexedDB), `js/zip.js` |
| 다운로드·공유 | `js/save.js` |
| 오프라인 캐시·업데이트 | `sw.js`, `js/app.js` 맨 아래 서비스워커 등록 |

## 수정할 때 꼭 지킬 것

1. **버전 두 곳을 같이 올린다**: `js/app.js`의 `APP_VERSION`과 `sw.js`의 `VERSION`.
   안 올리면 휴대폰에 옛 버전이 남는다 (GitHub Pages가 10분 캐시를 줘서 생겼던 문제, DESIGN.md v1.2.0).
2. **설정 기본값을 바꾸면** 이미 쓰던 폰에는 옛 값이 저장돼 있다 → `js/settings.js`의 `rev`를 올리고
   `REV_MIGRATIONS`에 옮길 값을 적는다 (예: v1.4.0에서 "사진에 표시" 기본값 끔).
3. 경로는 모두 **상대경로** (`/stamp-camera/` 하위에서 열림).
4. 검사를 돌리고(아래) DESIGN.md 7절에 버전별 변경 내역을 한 줄 이상 남긴다.
5. 커밋·푸시: 이 폴더(`바탕화면\CL\stamp-camera`)의 저장소에서. 상위 `CL` 폴더는 다른 저장소(결함마킹도구)라 거기엔 커밋하지 않는다.

## 검사 (가짜 카메라로 실제 크롬에서)

```
node tests/serve.mjs 8123                     # 개발 서버 http://localhost:8123/
"C:\Program Files\Google\Chrome\Application\chrome.exe" --headless=new --remote-debugging-port=9222 ^
    --user-data-dir=<빈 임시폴더> --use-fake-device-for-media-stream --use-fake-ui-for-media-stream about:blank
node tests/test-app.mjs                       # 전체 흐름 검사 (스크린샷·다운로드는 tests/out/)
node tests/test-update.mjs [예전 커밋]        # 예전 버전 설치 → 지금 작업본 배포 시 업데이트 반영 검사
APP_URL=https://yeop9701.github.io/stamp-camera/ node tests/test-app.mjs   # 배포본 검사
```

- 크롬 프로필 폴더는 매번 빈 폴더로 (남은 캐시·다운로드 기록이 검사를 흐림).
- 가짜 카메라는 3840×2160(16:9)이라 4:3 자르기 경로가 늘 검사된다. 플래시는 검사 안에서 흉내 낸다.
- 아이콘 다시 만들기: `node tests/make-icons.mjs`
