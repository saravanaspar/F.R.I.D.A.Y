# F.R.I.D.A.Y Android client boundary

Android is a Phase 7 client and is intentionally not part of the Phase 6 desktop
slice. This folder reserves the product boundary for the Kotlin/Jetpack Compose
app: it will consume the shared client protocol and Client Gateway, keep a Room
cache, use Android Keystore for device identity, and never execute Agent work
locally.

The first Android implementation should begin only after the desktop protocol and
desktop reconnect/cache schemas are stable.
