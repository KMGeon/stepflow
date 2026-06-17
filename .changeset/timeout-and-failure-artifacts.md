---
'@kmgeon/stepflow-core': minor
---

step별 timeout(`.timeout(step, ms)`)과 실패 아티팩트 캡처(`artifactSink`) 추가

- `defineJob().timeout(stepName, ms)`: step별 시도-단위 타임아웃. 초과 시 `StepTimeoutError`로 throw되어 기존 retry 예산 안에서 재시도되고, 타임아웃 시 step에 주입된 `AbortSignal`이 abort된다(협조적 중단). chunk step에는 설정 불가.
- `runJob({ artifactSink })`: step이 최종 실패할 때 1회, 주입된 `page`에서 스크린샷/HTML/URL/콘솔 로그를 best-effort로 캡처해 `artifactSink` 콜백에 전달한다. 저장 위치는 소비자가 결정(엔진은 fs/DB를 소유하지 않음). sink 미지정 시 캡처 경로는 건너뛴다.
- 두 기능 모두 옵트인이며, 미사용 시 기존 동작은 변하지 않는다.
