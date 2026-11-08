# Licenses

iDeviceKit's own code: MIT (see `LICENSE`).

Upstream components (not yet linked — Milestone 3). Official sources: https://github.com/libimobiledevice
| Component | Pinned | License |
|---|---|---|
| libplist | 2.8.1 | LGPL-2.1+ |
| libimobiledevice-glue | 1.3.3 | LGPL-2.1+ |
| libusbmuxd | 2.1.1 | LGPL-2.1+ (tools GPL-2/3) |
| libimobiledevice | 1.4.0 | LGPL-2.1+ (tools GPL) |
| OpenSSL | 3.x (TBD) | Apache-2.0 |

**LGPL note:** static linking into an iOS app has well-known compliance friction (users must be able to relink). Because this repo is public and distributes full source plus build scripts, relinking is possible, but you must still ship the license texts and not use the GPL-licensed CLI tool sources inside the app. Needs legal review before App Store distribution. License texts will be copied to `third_party/licenses/` when the libraries are integrated.
