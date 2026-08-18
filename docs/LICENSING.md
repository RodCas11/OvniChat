# Licensing and upstream-code policy

> Policy snapshot: **2026-08-17**. This document records conservative engineering rules; it is not
> legal advice. Escalate unclear licensing, combination, distribution, and network-use questions to
> qualified legal counsel before implementation or release.

## Current project status: UNLICENSED

Disco Voador currently has **no project license grant**. The root `package.json` declares
`"license": "UNLICENSED"`, and the repository has no owner-approved license text. Package metadata
is not a substitute for a license agreement.

Until the copyright owner selects and publishes a license, do not assume permission to copy,
redistribute, sublicense, or use this project's source outside rights supplied by applicable law or
a separate written agreement. “Source available in a repository” does not mean open source. Do not
add a license file, public-release artifact, or external contribution process without an explicit
owner decision and compatibility review.

Before the first distribution or hosted production release, choose the intended project license,
inventory third-party material, generate the required notices and source offers, and have the
result reviewed. A future project license cannot erase obligations attached to code already copied
from another work.

## Dependency and asset review

Every runtime and development dependency, vendored file, binary, native component, codec, model,
font, icon, image, sound, fixture, and generated artifact must have traceable provenance. Before
adding one:

1. Record its canonical upstream project, exact version or commit, retrieval source, purpose, and
   applicable license.
2. Read the license text and accompanying `NOTICE`, attribution, patent, trademark, source-offer,
   model, data, or asset terms. Do not rely solely on a package-registry field or GitHub badge.
3. Check transitive dependencies and determine what is actually packaged, linked, downloaded, or
   served to users. A development dependency can still affect distributed output.
4. Confirm compatibility with the project's intended distribution, modification, linking, and
   hosted-service model. Preserve required copyright and license notices.
5. Prefer the dependency's original release over a copy embedded in another repository. Verify the
   exact version independently.
6. Pin reproducible versions and update the inventory when the version, build process, packaging, or
   use changes.

MIT, BSD, and Apache licenses are not “no-obligation” licenses; their notices and conditions still
apply. GPL, AGPL, LGPL, MPL, SSPL, Business Source License, source-available, non-commercial,
field-of-use, custom, missing, or ambiguous terms require explicit review before adoption. Native
media components and codecs also need patent and redistribution review independent of copyright
licensing.

Do not vendor a dependency merely for convenience. If vendoring is justified, keep the upstream
license and notices beside it, document local modifications and dates, and make update and security
ownership explicit. Before release, create an owner-approved third-party notices artifact reflecting
what the shipped product actually contains.

## Reference and derived-code rules

The default for an external implementation is **reference-only, independent implementation**:

- Start from standards, platform documentation, project requirements, and black-box behavior.
- Write the requirement and tests in original language before writing the implementation.
- Record upstream repository, exact commit, path/symbol, reason for inspection, and conclusions in
  original words.
- Do not copy or closely translate code, comments, distinctive structure, tests, fixtures, assets,
  models, translations, or minified output.
- Review the finished change for accidental expressive similarity and retained upstream material.

Ideas, methods, protocols, and observable behavior may be different from protected source-code
expression, but that distinction is fact- and jurisdiction-specific. The policy above reduces risk;
it does not make a legal determination.

If materially copied or adapted source is proposed, stop and obtain a written licensing decision
and legal review before adding it. If approved, at minimum:

- isolate the material in a clearly identified package or directory for auditability;
- retain all required copyright, license, attribution, patent, and notice text;
- add an accurate SPDX identifier where the license permits it;
- record the exact upstream URL, commit, path, author information, modifications, and dates;
- document how source, notices, installation information, and network source offers will be supplied;
- verify compatibility with the license selected for the rest of the project.

**Isolation is an audit technique, not a license exception.** Putting copied code in another file,
package, process, executable, container, or network service does not by itself prevent a derivative
or combined work, change its license, or resolve copyleft obligations. Whether components form one
covered work depends on the facts and applicable law.

## AGPL-specific boundary

The VDO.Ninja source repository and `steveseguin/websocket_server` are governed by GNU AGPL v3 for
the relevant original source, subject to any explicit per-file override. Their precise pinned
revisions, mixed-provenance findings, and permitted research workflow are documented in
[`docs/references/VDO_NINJA.md`](references/VDO_NINJA.md).

AGPL v3 includes obligations for modified covered programs used to interact with users remotely
over a network, in addition to requirements associated with modification and conveying copies.
Linking, adapting, or combining AGPL-covered implementation code can create obligations for a
larger covered work. Do not assume that an Electron boundary, worker, package, WebSocket service,
separate process, or deployment topology avoids those obligations.

Accordingly:

- Do not copy VDO.Ninja or its WebSocket-server implementation into this project under the ordinary
  development workflow.
- Do not reproduce its distinctive routing, state-machine, or media-management implementation by
  close translation.
- Do not treat a permissively licensed fragment found inside VDO.Ninja as reusable until its exact
  original source, version, license, notices, and surrounding modifications have been verified.
- If AGPL code is intentionally adopted, obtain owner and legal approval for the resulting license,
  source-availability, corresponding-source, notice, and remote-network compliance plan before work
  begins.

## Primary legal references

- [GNU Affero General Public License version 3](https://www.gnu.org/licenses/agpl.html)
- [GNU GPL and AGPL frequently asked questions](https://www.gnu.org/licenses/gpl-faq.en.html)
- [17 U.S.C. § 102(b)](https://www.law.cornell.edu/uscode/text/17/102)
- [U.S. Copyright Office Circular 31](https://www.copyright.gov/circs/circ31.pdf)

These sources help explain the conservative policy, but they do not replace advice for the
project's ownership, jurisdictions, architecture, and release model.
