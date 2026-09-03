# Support

Booking Engine is a pre-release project. The runtime is not recommended for production traffic.
`@booking-engine/sdk-typescript` version `0.1.0` is an unpublished release candidate; the support
scope below does not mean that this version is available from a registry.

## Support scope

Maintainers support:

- the versioned Booking Engine V1 HTTP contract and the dependency-free TypeScript SDK;
- the documented Node.js `22.23.1`, pnpm `10.12.1`, PostgreSQL, and Docker Compose development
  flow; and
- reproducible bugs in the public SDK, public HTTP contract, and documented self-hosting flow.

The repository's other workspace packages are private implementation or test packages. The
self-hosted application is a reference implementation, not a hosted service or production support
commitment. This release does not activate live Stripe payments, notification delivery, background
scheduling, expiry workers, outbox delivery, or background iCalendar synchronization.

There is no uptime commitment, response-time SLA, or promise of production incident response for
this pre-release. Do not send credentials, guest data, private calendar URLs, database URLs, or
other secrets in an issue or support request.

## Questions and usage help

For a normal question, open a [blank GitHub issue](https://github.com/fioai/booker/issues/new). Include
the relevant SDK or runtime version, Node.js and package-manager versions, operating system, the
smallest example that demonstrates the question, and any error output with secrets removed.

Search existing issues first. Maintainers may ask for a minimal reproduction before investigating.
There is no guaranteed response time.

## Bug reports

Use the [Bug report form](https://github.com/fioai/booker/issues/new?template=bug.yml). Include:

- the exact version and whether the report uses the SDK or the runtime;
- a minimal reproduction and exact steps;
- expected and actual behavior;
- environment details; and
- redacted logs or responses, when useful.

Do not include authentication values, payment data, guest personal information, or any other
secret. If the report could expose a vulnerability, do not file it publicly; use the private
security path below.

## Feature requests

Use the [Feature request form](https://github.com/fioai/booker/issues/new?template=feature.yml). Explain
the user problem, proposed behavior, affected public contract, alternatives considered, and any
migration or privacy concerns. A feature request is not a commitment to implement the proposal.

## Security reports

Report suspected vulnerabilities privately through [GitHub Security Advisories](https://github.com/fioai/booker/security/advisories/new), as described in [`SECURITY.md`](SECURITY.md). Do not open a public issue for an undisclosed vulnerability.
