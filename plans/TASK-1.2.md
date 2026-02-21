# Task 1.2: Redesign TopBar + StatusBar + ThemePicker

## What
- TopBar: draggable region, underline indicator on active tab (not bg swap), truncated project name, theme picker as small swatch circle
- StatusBar: minimal with monospace counts, green/red connection dot, version in dim
- ThemePicker: dropdown with color swatch preview, checkmark on selected, smooth open/close

## Files changed
- `src/components/shared/TopBar.jsx`
- `src/components/shared/StatusBar.jsx`
- `src/components/shared/ThemePicker.jsx`

## Design rules
- Tab buttons: underline indicator on active, not background swap
- StatusBar: all text in var(--dim), monospace for counts
- ThemePicker: dropdown, not inline row of dots

## Verification
- `npx vite build` exits 0

## Risks
- Dropdown ThemePicker needs click-outside-to-close logic
- Traffic light padding must be preserved
