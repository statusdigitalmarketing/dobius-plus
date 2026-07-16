// Dobius+ fork: master switch that keeps this build from contacting any upstream
// dobius service — update feeds, changelog/nudge, prerelease feed, GitHub
// star, telemetry. Guards early-return their neutral value when this is true.
export const DOBIUS_SERVICES_DISCONNECTED = true
