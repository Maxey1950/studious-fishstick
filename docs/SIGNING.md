# Signing with a free Apple ID (Personal Team) — no Mac

Unsigned builds work out of the box (`ci.yml` → Simulator `.app`; `release-ipa.yml` with no secrets → **unsigned** `iDeviceKit-unsigned.ipa`, which you may sign with your own sideloading tool).
To have GitHub sign for you, add three **repository secrets** (Settings → Secrets and variables → Actions). Never commit these files (`.gitignore` blocks `*.p12`, `*.mobileprovision`).

| Secret | Content |
|---|---|
| `IOS_CERT_P12_BASE64` | Apple Development certificate + private key exported as .p12, base64-encoded |
| `IOS_CERT_PASSWORD` | the .p12 export password |
| `IOS_PROVISION_PROFILE_BASE64` | development `.mobileprovision`, base64-encoded |

Encode in WSL: `base64 -w0 cert.p12 | gh secret set IOS_CERT_P12_BASE64` (and likewise for the others; `gh secret set IOS_CERT_PASSWORD`).

## Getting the certificate/profile without a Mac
Apple only issues Personal-Team certificates and profiles via Xcode (or Xcode-compatible tooling). Options, all your responsibility to evaluate:
1. Borrow a Mac once, sign in to Xcode with your Apple ID, build any app to your phone, export the "Apple Development" cert from Keychain Access (.p12) and take the profile from `~/Library/MobileDevice/Provisioning Profiles`.
2. Use a third-party sideloading tool (AltStore/SideStore/Sideloadly) that manages the free-account certificate and re-signs the **unsigned IPA** for you. This is the no-Mac route and requires no secrets in GitHub.

## Constraints
- Profiles for free accounts **expire after 7 days**; re-sign/renew weekly. The workflow prints the profile expiry date.
- Bundle ID must be unique to your team and match the profile: pass `bundle_id` when running the workflow.
- Free accounts can't use capabilities beyond the basics; iDeviceKit declares no entitlements.
- Max 3 sideloaded apps / 10 App IDs per week on free accounts.
