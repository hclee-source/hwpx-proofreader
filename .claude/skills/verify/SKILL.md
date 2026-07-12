---
name: verify
description: 이 저장소(단일 index.html 웹앱)의 변경을 실기동으로 검증하는 레시피. 로컬 서버 + puppeteer-core로 실제 Chrome을 구동해 업로드·클릭·다운로드를 관찰한다.
---

# HWPX 교정 도구 실기동 검증

## 핵심 함정 (반드시 알 것)

- **index.html에는 인라인 스크립트가 2개**: script A(HWPX 코어 — `state`, `handleFile`, 규칙 엔진)와 script B(파일 하단, **전체가 IIFE로 감싸인 공용 모듈** — AI 호출 `window.hwpxAiCall`, 문제집 검수 `window.hwpxExamState`). script B 내부 선언은 전역이 아니다. 두 스크립트가 공유해야 하는 상태는 `window.*`에 명시적으로 노출해야 하며, script A 쪽 참조는 모듈이 죽어도 살아남게 `if (window.X)` 가드를 건다. (PDF 교정 모드는 2026-07-12 제거됨)
- node로 스크립트 구간을 eval하는 단위 테스트(`tests/exam_test.js`)는 전역 스코프라 **이 스코프 문제를 못 잡는다**. 스코프를 넘나드는 변경은 반드시 브라우저 실기동으로 확인.

## 빌드/실행

정적 페이지라 빌드 없음. CDN(jszip) 로드가 필요하므로 인터넷 연결 필요.

```bash
# 저장소 루트에서
python -m http.server 8123   # 백그라운드로
```

## 구동 (headless Chrome)

puppeteer-core를 임시 폴더에 설치하고 시스템 Chrome을 사용:

```bash
npm i puppeteer-core   # 브라우저 다운로드 없음, ~5초
```

```js
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',  // 경로에 역슬래시 이스케이프 주의
  headless: 'new' });
// 클립보드 검증: context.overridePermissions(origin, ['clipboard-read','clipboard-write'])
// 다운로드 검증: CDP 'Browser.setDownloadBehavior' { behavior:'allow', downloadPath }
```

## 검증 플로우

1. `page.on('pageerror')` 리스너를 **goto 전에** 부착 — 스코프 오류가 여기서 잡힌다.
2. 합성 HWPX 생성: `Contents/section0.xml` 하나짜리 zip이면 로더가 받는다 (PowerShell `[System.IO.Compression.ZipFile]`로 슬래시(`/`) 엔트리 생성). 문단은 `<hp:p><hp:run><hp:t>텍스트</hp:t></hp:run></hp:p>`, 네임스페이스 `http://www.hancom.co.kr/hwpml/2011/paragraph`. 탭은 `<hp:tab/>`를 hp:t 안에.
3. `#fileInput`에 `uploadFile()` → `#hwpxExamCheckBtn.disabled === false` 대기 (10초). 여기서 멈추면 handleFile의 try 블록 중간에서 죽은 것 — pageerror 확인.
4. 아코디언은 헤더 클릭으로 열고(`#hwpxExamPanel .accordion-header`), 버튼 클릭 후 결과 div `innerText` 캡처.
5. 다운로드 파일은 downloadPath 폴더 폴링(300ms×20)으로 확인. UTF-8 BOM은 첫 3바이트 EF BB BF.

## 회귀 테스트

```bash
node tests/exam_test.js   # 문제집 검수 파서·분석 36+건, index.html에서 구간 추출해 실행
```
