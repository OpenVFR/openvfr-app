# Todo

## Native app

- **Investigate "Maximum update depth exceeded" (native).** Red toast recurs
  about every 22 s while a simulated flight runs at a narrow width
  (density 700, ~329 dp, Samsung SM_S918B). Reproduced on `cf49c34` without
  the gauge/sim-panel layout edits, so those are not the cause. Not yet
  reproduced on `7178f37` (the attempt never started the simulation, so it is
  inconclusive). Next: open the toast to read the component stack; bisect
  between `7178f37` and `cf49c34` with a confirmed running simulation;
  suspects are barometer-era effects with unstable dependencies
  (`positionForAlerts` in `MapScreen` now changes every second via
  `altitudeSource.altFt`, `useFieldQnh`/`useNearestAerodrome`, `VarioContext`
  value identity).
- `SimControlPanel`: heading shows `00…` at ~329 dp; tighten sizing.
- Add `.catch` to `queryRenderedFeatures`/`unproject` calls in
  `AviationMap.tsx` (unhandled rejection after activity restart).
- Device-test barometer flow: prompt and persistence, VS filter tuning,
  field QNH, BlueFly in auto-QNH mode, iOS Motion prompt, release-build
  permissions.
