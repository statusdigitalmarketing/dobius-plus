# Signing the Windows installer (Azure Trusted Signing)

Unsigned, Windows shows a SmartScreen "Windows protected your PC" warning on install and on every update. Azure
Trusted Signing (Microsoft also calls it Artifact Signing) signs the installer in CI with a certificate Microsoft
holds, so there is no key file to keep safe. Sam chose it on 2026-11-08.

The CI side is already wired (`.github/workflows/windows.yml`, step "Build installer"): it signs as soon as the
three secrets and four variables below exist, and builds unsigned until then. A signed build is checked
(`Get-AuthenticodeSignature`: valid and timestamped) before it can be attached to a release.

## What has to be done in Azure (needs Sam's Microsoft login and payment)

1. Azure subscription (pay as you go is fine). In the subscription, register the resource provider
   `Microsoft.CodeSigning` (Subscriptions > Resource providers).
2. Create a Trusted Signing account: Basic plan, region e.g. East US. Note its **account name** and its
   **endpoint** (East US is `https://eus.codesigning.azure.net/`; the portal shows it on the account's Overview).
3. Identity validation (in the account: Identity validation > New > Public Trust). Organization: the legal business
   name and documents it asks for. This is the slow step: Microsoft reviews it, usually days. The name validated here
   is what Windows shows as the publisher.
4. After validation: Certificate profiles > Create > Public Trust, choose that validation. Note the **profile name**.
5. Microsoft Entra ID > App registrations > New registration (e.g. "dobius-ci-signing"). Note the **tenant id** and
   **client id**; Certificates & secrets > New client secret, copy the **value** (shown once).
6. On the Trusted Signing account: Access control (IAM) > Add role assignment > "Trusted Signing Certificate Profile
   Signer" (may be listed as "Artifact Signing Certificate Profile Signer") > the app registration from step 5.

## What goes into GitHub (statusdigitalmarketing/dobius-plus > Settings > Secrets and variables > Actions)

| Kind | Name | Value |
|---|---|---|
| Secret | `AZURE_TENANT_ID` | tenant id (step 5) |
| Secret | `AZURE_CLIENT_ID` | client id (step 5) |
| Secret | `AZURE_CLIENT_SECRET` | client secret value (step 5) |
| Variable | `AZURE_TS_ENDPOINT` | endpoint (step 2) |
| Variable | `AZURE_TS_ACCOUNT` | Trusted Signing account name (step 2), not the resource group |
| Variable | `AZURE_TS_PROFILE` | certificate profile name (step 4) |
| Variable | `AZURE_TS_PUBLISHER` | the validated publisher name exactly as on the certificate (step 3) |

Then run the Windows workflow by hand (Actions > Windows build > Run workflow) and look for "Signing with Azure
Trusted Signing" and a Valid signature in "Check the installer signature".

## Notes
- The secrets reach only this repo's own pushes, releases and manual runs: the workflow has no `pull_request`
  trigger, so a fork's code never sees them.
- electron-builder 26.8.1 passes the timestamp server (`http://timestamp.acs.microsoft.com`) by default, so signed
  installers stay valid after the certificate rotates.
- Updates: electron-updater on Windows checks that a new installer is signed by the same publisher as the installed
  one. The first signed release after unsigned ones installs normally; changing the publisher name later would not.

## Status (2026-11-08)
- Subscription: "Azure subscription 1" (55bb9394-1cea-46f3-8241-fcea9c07c91a), tenant b0358da5-802b-44e3-b402-11f27a5f6a10
  (sahil.nihal@yahoo.com), upgraded to pay as you go. `Microsoft.CodeSigning` registered, resource group
  `rg-dobius-signing` (East US) created.
- Signing account `dobiusplus`: refused while Azure still reported the subscription as Free Trial right after the
  upgrade ("not available for free, trial or sponsored subscriptions"); create it once the quota id reads PayAsYouGo.
- CI login: `scratchpad`-style script run by Sam (creating credentials needs his hand): app registration
  `dobius-ci-signing`, its secret piped straight into the GitHub secret, never printed.
- Still to do: identity validation (Sam, portal), certificate profile, role assignment, the four variables.
