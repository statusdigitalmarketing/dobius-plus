# Task 2.4 Review — BuildHealthGauge + SupervisorStatus

## Three things that could be better
1. BuildHealthGauge uses hardcoded `#E3B341` (amber) and `#F85149` (red) for gauge colors — these could be CSS variables, but the gauge is specifically a health indicator and these match GitHub's semantic colors.
2. The health score formula (100 - failures*10 - restarts*5) is simplistic — could weight by severity, but it's intuitive and easy to reason about.
3. SupervisorStatus mini-terminal uses array index as key — log lines may shift, but since we only show last 5 lines, this is acceptable.

## One thing I'm fixing right now
Nothing — both components are clean presentation components.

## Concerns
- The SVG arc math assumes a 140x80 viewport with fixed radius — responsive scaling would need viewBox adjustments, but the gauge is always displayed at a fixed size.
