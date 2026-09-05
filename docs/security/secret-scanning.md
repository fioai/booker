# Secret scanning

Run `corepack pnpm scan:secrets` for tracked, staged, and non-ignored working files, and
`corepack pnpm scan:history` for every unique blob reachable from all local Git refs. History
scanning requires a full clone. Both commands report locations and rule names without printing
credential values. These marker-based scans do not replace review of ignored files, external
secret stores, or credentials without a recognized marker.

A tracked file deleted from the working tree is checked using its index contents until the
deletion is staged. Other unreadable files and unresolved index conflicts fail the scan.

## Reviewed demo images

The three demo assets below were visually reviewed on 2026-09-05. The cabin photograph is a
public CC0 image; its visible signs identify the photographed rental, not a private fixture or
credential. See the [photo credit](../../examples/cabin/README.md#photograph). The screenshots
show the local example and fictional guest details; no real guest, owner credential, session
cookie, or developer console is visible. All three files are JPEGs. Their metadata was also
inspected; the photograph contains ordinary color-profile and editing metadata.

These exact file paths and SHA-256 contents are classified as `reviewed-demo-image` in the
placeholder totals. The same policy applies to working files, the index and historical blobs.
Unreviewed bytes or a different path receive no exception. New screenshots require a fresh visual
and metadata review before updating the hashes in `scripts/lib/secret-scanner.mjs`.

| Path                              | SHA-256                                                            |
| --------------------------------- | ------------------------------------------------------------------ |
| `examples/cabin/public/cabin.jpg` | `bf2c83bdffd897050828a39d5ef2f2957e5b8fb79a85c94d71aac1b96691b3a5` |
| `docs/images/cabin-demo.jpg`      | `308ba73b62b061a86715d17c897c2691273add7fc2b917c99c23e24888042806` |
| `docs/images/owner-inbox.jpg`     | `0d0053356d6aefa711f281e3f3ca6214bf2de43f0026a632a54448ef28596b4e` |

Earlier versions were reviewed on the same date and remain reachable through local Git refs,
including saved worktree snapshots. Their exact hashes remain accepted so history scans can
inspect them. The generated PNG has been removed from the current example.

| Earlier path                      | SHA-256                                                            |
| --------------------------------- | ------------------------------------------------------------------ |
| `docs/images/cabin-demo.jpg`      | `a9eba6ee33e494e465ffb4e63207e447447681bf5a776c2b77b73f24416a16b9` |
| `examples/cabin/public/cabin.png` | `492f3cf6b1727df5bef3b267a98cfc9a521ef8cf6bd8ce919575ee22d8115790` |
| `docs/images/cabin-demo.jpg`      | `0006a1b513ca714f201aaaaecec2ac9591dab7aaa9412b80d098510489af3aa7` |
| `docs/images/owner-inbox.jpg`     | `442c80ef7a701f4be25d703d03ff5307bda67694145a27d0a14f808c32af2c90` |

The earlier PNG contains generation provenance; its screenshots contain only fictional sample
data and basic JPEG metadata. The bounded per-file read limit remains 4 MiB to inspect that
3.5 MiB historical PNG. Other binaries and archives still fail; text files within the limit are
scanned normally. This is not a general image or directory exclusion.

## Reviewed historical samples

The following findings were reviewed on 2026-09-05. They are development fixtures, classified as
explicit placeholders by the history scanner. Exceptions match the complete Git blob ID, path,
line, and `database-url-credential` rule. The rest of each blob is still scanned, and changing any
content produces a new blob that receives no exception. Current-tree scanning has no exceptions
for these historical values. No Git history was rewritten.

| Git blob ID                                | Path and line                                   | Reason                                                                                                                             |
| ------------------------------------------ | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `1659831f04c0d23b8af55a859f838613ce5644d2` | `tests/hardening/hardening-contract.test.ts:41` | URL at the reserved `example.test` host in the sample-data rejection test; the validation command performs no database connection. |
| `76a535cfa1d6fdef3b094f499d821400ae2ac4e2` | `tests/hardening/hardening-contract.test.ts:41` | Earlier blob containing the same test URL.                                                                                         |
| `5d54ee034b91540a6415cf2dc6ad0abaac8c97e0` | `tests/hardening/hardening-contract.test.ts:41` | Earlier blob containing the same test URL.                                                                                         |
| `fa2933914b9a5ae4a906f648295b0dcc15ebc24a` | `docker-compose.yml:27`                         | Historical Compose interpolation with the explicit `local-only-placeholder` password fallback and local PostgreSQL service.        |

Any new finding must be investigated. Do not add a directory exclusion, accept arbitrary
passwords at example hosts, or skip an unreviewed blob to make a scan pass. For a real credential,
follow [SECURITY.md](../../SECURITY.md) and revoke or rotate it before release.
