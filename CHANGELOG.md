# Changelog

## 6.5-pages (pull request, not deployed yet)

### Fixed
- Final result was always empty (no HR, SQI 0.00, fallback questionnaire) when the capture loop ran at about 22 Hz or faster, which is every capture that passes the preflight. The per-ROI history is now bounded by time (50 s) instead of 600 samples, and `estimate()` uses whatever history is available down to 6 s.
- HR read about double on 60 and 120 Hz displays and with 60 fps cameras (62 bpm shown as about 123). FaceMesh now gets one frame per camera frame (`requestVideoFrameCallback`, or a `video.currentTime` check), samples carry the camera frame time, repeated timestamps are dropped, and every ROI is resampled to a 30 Hz grid before the fixed 30 Hz bandpass.
- The quality gate passed pure noise (random HR shown live and with SQI up to 1.00). `snrDb` is now a harmonic-band SNR and SQI comes from a per-window calibration (`SQI_CALIBRATION`, reproducible with `node test/calibrate_sqi.mjs`). The live HR, the ring, the per-ROI overlay and the result screen all use this SQI with one threshold (0.6). Calibrated and tested on synthetic white and AR(1) low-pass noise only, not on recordings.
- Result screen: an in-browser HR below SQI 0.6 is no longer printed; the low-quality chip now covers every SQI between 0 and 0.6 (was 0.35 to 0.55); the rationale card no longer stays visible from an earlier run.
- Preflight could hang forever without a face or when the face model failed to load. It now shows the face hint, then a failed check with a retry button ("얼굴 인식", "얼굴 인식 모델" or "카메라 영상"). A camera that disconnects ends the run with a message.
- Cancelling a demo run did not stop it; about 45 s later it took over the screen. Runs now carry an id that the demo tick and late backend replies check.
- Elements with the `hidden` attribute stayed visible when a component rule set `display: flex` (capture sidebar during preflight, rating buttons during playback).
- Every camera error was reported as a refusal. Permission, no camera, camera in use, unsupported settings (retried once with `video: true`) and insecure page now get their own Korean message.
- Messages and README pointed to files that are not in this repo (`/frontend/`, `BELL-HRV-PoC.command`, `setup_sounds.sh`); README had the wrong capture length and asset type.
- Nested imports used stale cache-bust strings (`dsp.js?v=6.0`, `sound_mapping.js?v=4.2`), so `sound_mapping.js` loaded twice. All `?v=` values are now `6.5-pages`.
- `applyIIR` keeps its filter state in float64 (float32 state was up to 0.25 % off scipy).

### Added
- Stop button and volume slider on the sound screen (the slider starts at the current master level and only lowers it). Breath cues stop with the sound.
- Node tests (`npm test`, no dependencies, offline): scipy reference for the bandpass, rPPG tests for the fixes above, preflight frame-rate tests, static checks (one `?v=` string, SRI and CSP, wiring of the fixes). GitHub Actions workflow runs them on pull requests and pushes to main.

### Changed
- MediaPipe Face Mesh is pinned to 0.4.1633559619 with SRI, in the script tag and in `locateFile`; the unused `camera_utils` script is removed; a Content Security Policy limits scripts and connections to this site, the pinned MediaPipe path, the Pretendard font and the local backend.
- Preflight frame rate: the 28 fps check now applies to camera frames (counted with `presentedFrames` where available) and FaceMesh must analyse at least 15 frames per second. Before, it counted display-rate loop results, so a 24 to 27 fps webcam passed; it now fails this row.
- The live HR uses hysteresis: shown from SQI 0.6, kept while SQI stays at or above 0.45.
- Small allocations removed from the per-frame path (ROI canvas no longer resized every frame, cached CSS colours, fixed preflight scratch canvases, reused analyser buffer).

### Not changed (owner decision)
- On-screen wording that claims autonomic or HRV measurement on the static build, the self-report shown as a measured state, the demo SQI override and the "30초 호흡" subtitle. After this release a clean capture shows SQI up to 1.00 next to "추정 어려움" and the low-quality interpretation text, because the static build never computes an autonomic state.
- Breath recordings are still played 1.46x to 3.35x fast.
