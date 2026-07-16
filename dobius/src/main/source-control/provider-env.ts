export function readProviderEnv(name: string): string | null {
  const dobiusValue = process.env[`DOBIUS_${name}`]?.trim() ?? ''
  return dobiusValue.length > 0 ? dobiusValue : null
}
