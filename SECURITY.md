# Security policy

## Supported versions

jevascript is pre-1.0. Security fixes land in the latest 0.x release only.

## Reporting a vulnerability

Please **do not open a public issue**. Report privately through GitHub:
**Security → Report a vulnerability** on
[this repository](https://github.com/hakantapanyigit/jevascript/security/advisories/new).

Include what you can: the affected version, a minimal reproduction, and the impact you
expect. You should get an acknowledgement within a few days, and a fix or a clear answer
before anything is disclosed.

## What counts

In scope — defects in this library, for example:

- an API key, request body or state leaking into logs, errors or events
- a cache that serves one state's answer for another's
- a result that contradicts its type or options (say, `"unknown"` arriving where
  `boolean` was promised), or any path that turns an uncertain or failed evaluation into a
  confident one
- a provider response that is accepted when it should be rejected

Out of scope — the behaviour of the model itself. A decision model can be steered by content
that genuinely asserts new facts; that is documented and measured in the README under
[Not a security boundary](README.md#not-a-security-boundary). Semantic evaluation is a soft
review layer: authentication, authorisation and payment limits must stay deterministic. A
report that the model can be persuaded is not a vulnerability; a report that *this library*
lets that persuasion bypass a deterministic check is.
