# Task 2.1 Review

## Three things that could be better
1. The ThemePicker uses fixed-size circles — could show theme names on hover with a tooltip
2. The mixColor function is very basic — could use a proper color library, but YAGNI for now
3. The magenta color logic in makeXtermTheme has a special case for Phantom theme — could be cleaner

## One thing I'm fixing right now
The xtermTheme bright colors should be slightly lighter versions of the base colors for better contrast. Currently they're identical. Fixing the makeXtermTheme function to adjust brightness.

## Concerns
- Theme persistence not implemented yet (Task 3.3)
- App.jsx currently has a temporary top bar for the ThemePicker — this will be replaced by the proper TopBar in Task 3.1
