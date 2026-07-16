export function getDobiusCliCommandNameForPlatform(platform: NodeJS.Platform): string {
  if (platform === 'win32') {
    return 'dobius.cmd'
  }
  return 'dobius'
}
