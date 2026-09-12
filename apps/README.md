# F.R.I.D.A.Y clients

The `apps/` tree contains presentation clients only. Durable state and privileged
operations stay behind the authenticated Client Gateway and the existing plugin
authorities.

- [`desktop/`](desktop/): Phase 6 desktop client first slice (chat → job → approval → artifact → computer panel).
- [`android/`](android/): Phase 7 Android/Compose boundary, intentionally not implemented in the Phase 6 slice.
