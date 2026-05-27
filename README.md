# BELL HRV PoC — Frontend (static)

5초 셀카 → rPPG → HRV → 상태 분류 → SAB 사운드 매핑 UI.

GitHub Pages 정적 배포본. 백엔드(`http://127.0.0.1:8765`)는 로컬에서만 호출되며, 정적 호스트에선 자동으로 in-browser rPPG 추정값만 사용한다.

## 로컬에서 띄우기

```sh
python3 -m http.server 8000
# → http://localhost:8000/
```

iOS Safari에서 테스트하려면 ngrok 등으로 HTTPS 터널 필요 (카메라 권한은 HTTPS에서만).

## 진단 모드

URL 끝에 `?debug=1` 붙이면 측정 시작 시 단계별 trace가 화면 하단 빨간 띠에 표시된다. 평소에는 실제 throw/promise rejection만 표시.

## 디렉토리

- `index.html` — 단일 진입점
- `main.js` — orchestration
- `rppg_live.js` — POS + Butterworth + DFT (in-browser)
- `dsp.js`, `hrv_trace.js`, `preflight.js`, `sound.js`, `sound_mapping.js`
- `sounds/` — Web Audio용 wav 자산
