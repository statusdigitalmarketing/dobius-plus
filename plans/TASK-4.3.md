# Task 4.3 Plan — Launcher Window

## Goal
Create the main hub window that lists projects and opens project windows.

## Files to Create
- src/components/Launcher/ProjectList.jsx — Grid of project cards with search
- src/components/Launcher/ProjectCard.jsx — Single project card with hover effects

## Files to Modify
- src/App.jsx — If no projectPath in URL, render Launcher. Otherwise render ProjectView.
- electron/main.js — Initial window is Launcher (no project param). Launcher closing quits app.

## Design
1. ProjectList: Load projects via dataListProjects IPC, search filter, sort by recent activity
2. ProjectCard: Decoded name, session count, last activity time, theme swatch, click → windowOpenProject
3. App.jsx: Route based on URL query param presence
4. main.js: Default window has no project param (renders Launcher)
