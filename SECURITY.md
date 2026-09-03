# Security policy

Report suspected vulnerabilities through [GitHub Security Advisories for
`fioai/booker`](https://github.com/fioai/booker/security/advisories/new). Please do not open a
public issue for an undisclosed vulnerability.

The `0.1.x` release line of `@booking-engine/sdk-typescript` is the only intended public package.
Version `0.1.0` is currently an unpublished release candidate. Other workspace packages and the
self-hosted reference application are private implementation surfaces for this release.

For normal questions and bug reports, use the routes in [`SUPPORT.md`](SUPPORT.md).

Do not include guest PII, production credentials, access tokens, database URLs, private
calendar URLs, or other secrets in a report. Use synthetic identifiers and redact logs before
uploading evidence. Include reproduction steps, affected version/commit, impact, and any
mitigations that were tested.
