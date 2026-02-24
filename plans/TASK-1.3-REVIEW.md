# Task 1.3 Review — Preload + Auto-Capture

## 3 Improvements
1. Auto-capture uses reverse lookup from runningAgents to find agentId — clean O(n) over small map
2. Duration calculated from tab.createdAt — accurate for agent lifetime
3. Journal entry created before unregister to ensure agent is still tracked

## 1 Fix
- Added projectPath to useEffect dependency array since it's used in the journal entry
