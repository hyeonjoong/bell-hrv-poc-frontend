# BELL HRV PoC — Frontend (static)

얼굴 영상(3초 환경 점검 후 45초 측정), rPPG, HRV, 상태 분류, SAB 사운드 매핑으로 이어지는 UI.

GitHub Pages 정적 배포본. 백엔드(`http://127.0.0.1:8765`)는 로컬에서만 호출되며, 정적 호스트에선 자동으로 in-browser rPPG 추정값만 사용한다.

## 로컬에서 띄우기

```sh
python3 -m http.server 8000
# → http://localhost:8000/
```

브라우저는 HTTPS 또는 localhost 주소에서만 카메라를 허용한다. GitHub Pages 주소는 이미 HTTPS라 iPhone Safari에서도 그대로 열린다. 같은 와이파이의 다른 기기(iPhone 등)에서 이 로컬 서버(`http://<PC의 IP>:8000/`)를 열어 테스트할 때만 ngrok 같은 HTTPS 터널이 필요하다.

## 진단 모드

URL 끝에 `?debug=1` 붙이면 측정 시작 시 단계별 trace가 화면 하단 빨간 띠에 표시된다. 평소에는 실제 throw/promise rejection만 표시.

## 측정 흐름

1. 측정 전 점검(3초): 프레임 속도, 얼굴 밝기, 조명 균일도, 역광, 머리 안정성. 프레임 속도는 카메라 프레임이 28 fps 이상이고 실제로 분석한 프레임이 15 fps 이상이어야 통과한다. 얼굴 인식 결과는 오는데 8초 동안 얼굴이 없으면 "얼굴 인식" 실패, 얼굴 인식 모델을 불러오지 못하면(오류 또는 15초 무응답) 모델 실패, 카메라 영상이 8초 동안 들어오지 않으면 카메라 실패를 표시하고 "다시 시도" 버튼을 보여준다.
2. 측정(45초): 0.5초마다 최근 8초로 심박을 추정한다. 신호 품질(SQI)이 0.6 이상일 때만 심박수를 표시하고, 한 번 표시된 뒤에는 0.45 이상이면 유지한다. 링은 이 SQI만 보여주며 얼굴이 없거나 추정 전이면 회색이다.
3. 결과: 45초 전체로 다시 추정한다. SQI가 0.6 미만이면 브라우저 추정 심박수는 표시하지 않고, 낮은 품질 안내와 상태 선택 질문을 보여준다.
4. 사운드(60초): 멈춤 버튼과 음량 슬라이더가 있다. 슬라이더는 기존 음량에서 시작하며 줄이는 쪽으로만 움직인다.

## 신호 처리

- FaceMesh에는 카메라 프레임마다 한 번만 넣는다(`requestVideoFrameCallback`, 지원하지 않는 브라우저에서는 `video.currentTime`이 바뀔 때만). 표본 시각은 화면 갱신 시각이 아니라 카메라 프레임 시각이다.
- 이마, 왼쪽 볼, 오른쪽 볼의 RGB 평균을 영역별로 30 Hz 균일 격자에 선형 보간한 뒤 POS, 0.7~4 Hz Butterworth(4차, 양방향), DFT 피크로 심박을 구한다. 그래서 카메라 fps(15~60)나 화면 주사율(60, 120 Hz)에 관계없이 같은 필터가 맞다.
- 각 영역은 최근 50초를 보관한다. 영역별로 6초 이상 쌓여야 분석한다.
- SQI: 피크와 2배 고조파 주변 ±0.1 Hz의 파워를 0.7~7 Hz 나머지 파워와 비교한 값(dB)을 창 길이별 보정표(`rppg_live.js`의 `SQI_CALIBRATION`)로 0~1에 매핑한다. 보정표는 합성 신호(백색 잡음, AR(1) 저역 잡음, 맥파)로 만든 것이며, 실제 얼굴 영상과 맥박산소측정기로 검증한 값은 아니다.
- 정적 배포본은 심박수와 SQI만 계산한다. RMSSD, SDNN, SD1/SD2와 자율신경 상태는 로컬 백엔드(`http://127.0.0.1:8765`)가 응답할 때만 채워진다.

## 외부 리소스

- MediaPipe Face Mesh `0.4.1633559619`(jsDelivr)를 버전 고정과 SRI(`integrity`)로 불러온다. 버전을 바꿀 때는 `index.html`의 script 주소와 integrity 값, CSP, `main.js`의 `FACE_MESH_VERSION`을 함께 바꾼다. 해시 계산: `curl -s <face_mesh.js 주소> | openssl dgst -sha384 -binary | openssl base64 -A`
- Pretendard 웹폰트(jsDelivr).
- `index.html`의 CSP가 그 밖의 출처로 가는 요청을 막는다. MediaPipe가 동작하려면 `'unsafe-eval'`이 필요하다.

## 테스트

Node 22 이상, 설치할 의존성 없음, 네트워크 없이 동작한다.

```sh
npm test                                  # DSP, rPPG, preflight, 정적 검사
node test/calibrate_sqi.mjs               # SQI 보정표 다시 계산 (약 3분)
python3 test/fixtures/make_dsp_reference.py   # scipy 기준값 다시 생성 (numpy, scipy 필요)
```

GitHub Actions 워크플로(`.github/ci/test.yml`)를 켜면 PR과 main push마다 `node --check`와 `npm test`를 돌린다. 켜는 법은 `.github/ci/README.md` 에 있다.

모듈 import와 `index.html`의 `?v=` 캐시 무효화 값은 모두 같아야 한다(현재 `6.5-pages`, `npm test`가 확인). 모듈을 고치면 모든 값을 함께 올린다.

## 디렉토리

- `index.html` — 단일 진입점
- `main.js` — orchestration
- `rppg_live.js` — POS + Butterworth + DFT (in-browser)
- `dsp.js`, `hrv_trace.js`, `preflight.js`, `sound.js`, `sound_mapping.js`
- `sounds/`: Web Audio용 mp3 자산 (`sounds/breath/inhale.mp3`, `exhale.mp3`)
- `test/`, `package.json`: Node 테스트 (브라우저는 사용하지 않음)
