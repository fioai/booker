# Security policy

Report suspected vulnerabilities through [GitHub Security Advisories for
`fioai/booking-engine`](https://github.com/fioai/booking-engine/security/advisories/new).
Please do not open a public issue for an undisclosed vulnerability.

Only the `0.1.x` release line of `@booking-engine/sdk-typescript` is a supported public
package. Other workspace packages and the self-hosted reference application are private
implementation surfaces for this release.

Do not include guest PII, production credentials, access tokens, database URLs, private
calendar URLs, or other secrets in a report. Use synthetic identifiers and redact logs before
uploading evidence. Include reproduction steps, affected version/commit, impact, and any
mitigations that were tested.
