# Security Policy

## Supported versions

Only the latest released version receives security fixes.

## Reporting a vulnerability

Please **do not open a public issue**. Report it privately through
[GitHub Security Advisories](https://github.com/furkanmeclis/smith-charts-mcp/security/advisories/new)
or by e-mail to **furkanmeclis@icloud.com**. You will get a response within a few days.

## Deployment notes

- Over HTTP the server disables `touchstone_path` and `output_path`, so remote clients cannot read or write files on the host.
  Only set `SMITH_CHARTS_MCP_ALLOW_FS=1` on private, trusted deployments.
- The HTTP server is stateless and unauthenticated by design (it only performs calculations). Put it behind HTTPS, keep the
  per-IP rate limit (`RATE_LIMIT_PER_MINUTE`) enabled, and add authentication at your reverse proxy if you need it.
