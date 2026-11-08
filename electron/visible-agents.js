// The built-in agents the UI lists (Mission Control, Orchestrator), per platform.
// The Voice Conductor routes Siri / Meta-glasses voice and iMessage, which are
// macOS-only, so Windows does not offer it. Lookups by id (voice bridge,
// conductor start) keep using the full list. Pure, for tests.

export const VOICE_CONDUCTOR_ID = 'builtin-voice-conductor';

export function visibleBuiltinAgents(agents, platform = process.platform) {
  const list = Array.isArray(agents) ? agents : [];
  return platform === 'win32' ? list.filter((a) => a?.id !== VOICE_CONDUCTOR_ID) : list;
}
