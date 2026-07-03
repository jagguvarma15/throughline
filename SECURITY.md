# Security Policy

## Supported versions

Throughline is pre-1.0: only the latest 0.x release line receives security fixes.

## Reporting a vulnerability

Please **do not** open a public issue for security problems. Instead, report privately
via [GitHub Security Advisories](https://github.com/jagguvarma15/throughline/security/advisories/new).

Include what you can: affected package and version, a reproduction or proof of concept,
and impact (e.g. journal tampering, lease bypass, SQL injection through a store).

You can expect an acknowledgement within a week. Fixes ship as a patch release with a
GitHub advisory credit unless you prefer to stay anonymous.

## Scope notes

- The control-plane API (`apps/control-plane`) is a reference deployment: it ships with
  helmet, CORS, and rate limiting but **no authentication** — it is expected to run
  behind your own auth layer. Reports about missing auth there are out of scope;
  bypasses of the documented protections are in scope.
- Journal contents are stored verbatim: secrets you pass through step results end up in
  your database. That is documented behavior, not a vulnerability.
