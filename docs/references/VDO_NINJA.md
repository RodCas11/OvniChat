# VDO.Ninja reference policy

> Research snapshot: **2026-08-17**. The links below pin the exact revisions inspected. Do not
> silently replace them with floating branch URLs when recording provenance.

VDO.Ninja is a valuable behavioral reference for browser WebRTC, media-source management, and
self-hosted signaling. It is **not** a source library for this project. Disco Voador uses a
reference-only, independent-implementation policy because the relevant upstream code is governed
primarily by the GNU Affero General Public License version 3 (AGPL v3).

This is an engineering policy, not legal advice. See [`docs/LICENSING.md`](../LICENSING.md) before
adding any code, asset, model, dependency, or protocol implementation informed by an upstream
project.

## Revisions inspected

| Repository                                                                        | Default branch | Pinned revision                                                                                                                             | Role in research                                |
| --------------------------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| [`steveseguin/vdo.ninja`](https://github.com/steveseguin/vdo.ninja)               | `develop`      | [`4542e4bb2cfafb77e6ad20337126f44fa2b71c9f`](https://github.com/steveseguin/vdo.ninja/tree/4542e4bb2cfafb77e6ad20337126f44fa2b71c9f)        | Browser WebRTC/media behavior and configuration |
| [`steveseguin/websocket_server`](https://github.com/steveseguin/websocket_server) | `main`         | [`eb5a606e855cb4898ee733c1f8408beab298caef`](https://github.com/steveseguin/websocket_server/tree/eb5a606e855cb4898ee733c1f8408beab298caef) | Signaling topology and room-routing concepts    |

The inspected VDO.Ninja `develop` commit dates from 2026-07-09 UTC. Its latest release observed in
this snapshot was `v30.2`, but the pinned development revision above is the basis for these notes.
The inspected websocket server commit dates from 2025-10-08 UTC.

## License findings

### VDO.Ninja

The repository's controlling notice is spelled
[`LICENCE.md`](https://github.com/steveseguin/vdo.ninja/blob/4542e4bb2cfafb77e6ad20337126f44fa2b71c9f/LICENCE.md),
not `LICENSE.md`. It states that the source repository is governed by AGPL v3, that a different
license header in an individual file can override the repository default for that file, and that a
file without such an override remains AGPL v3. The repository also includes the
[full AGPL v3 text](https://github.com/steveseguin/vdo.ninja/blob/4542e4bb2cfafb77e6ad20337126f44fa2b71c9f/AGPLv3.md).

GitHub may display `NOASSERTION` for this repository because the controlling file is custom and uses
the British spelling. That does not mean there is no license. The upstream notice does not clearly
grant an “or later” option, and one project footer uses `AGPL-3.0-only`; this project therefore treats
the code conservatively as **AGPL-3.0-only** unless the copyright owner or qualified legal counsel
confirms otherwise.

The upstream
[`CONTRIBUTING.md`](https://github.com/steveseguin/vdo.ninja/blob/4542e4bb2cfafb77e6ad20337126f44fa2b71c9f/CONTRIBUTING.md)
gives the maintainer broad rights over contributor submissions. It does not give downstream users
additional permission to reuse the code.

VDO.Ninja also contains mixed-provenance material. Its
[`thirdparty/readme.md`](https://github.com/steveseguin/vdo.ninja/blob/4542e4bb2cfafb77e6ad20337126f44fa2b71c9f/thirdparty/readme.md)
says that directory is primarily MIT- or Apache-2.0-licensed, but it is not a complete bill of
materials. Examples include separately licensed
[Longpipe code](https://github.com/steveseguin/vdo.ninja/blob/4542e4bb2cfafb77e6ad20337126f44fa2b71c9f/thirdparty/longpipe/LICENSE),
[Longpipe weights](https://github.com/steveseguin/vdo.ninja/blob/4542e4bb2cfafb77e6ad20337126f44fa2b71c9f/thirdparty/longpipe/models/v/0.0.4/WEIGHTS_LICENSE),
[MediaPipe material](https://github.com/steveseguin/vdo.ninja/blob/4542e4bb2cfafb77e6ad20337126f44fa2b71c9f/thirdparty/mediapipe/LICENSE),
and [Jeeliz material](https://github.com/steveseguin/vdo.ninja/blob/4542e4bb2cfafb77e6ad20337126f44fa2b71c9f/thirdparty/jeeliz/readme.md).
Other files have incomplete, historical, or mixed notices. In particular:

- [`thirdparty/tflite/README.md`](https://github.com/steveseguin/vdo.ninja/blob/4542e4bb2cfafb77e6ad20337126f44fa2b71c9f/thirdparty/tflite/README.md)
  describes code whose Google licensing changed and is not safe to reuse without separate review.
- [`thirdparty/CodecsHandler.js`](https://github.com/steveseguin/vdo.ninja/blob/4542e4bb2cfafb77e6ad20337126f44fa2b71c9f/thirdparty/CodecsHandler.js)
  combines differently attributed fragments and upstream modifications.
- [`lineawesome/LICENSE.txt`](https://github.com/steveseguin/vdo.ninja/blob/4542e4bb2cfafb77e6ad20337126f44fa2b71c9f/lineawesome/LICENSE.txt)
  is an attribution request rather than a complete standard license grant.
- Some media identify provenance or terms only through filenames or origin links. That is not
  sufficient evidence for reuse.

Do not treat `thirdparty/`, `filters/`, `lineawesome/`, `examples/`, model directories, or media as
wholly permissive. Review each file, and obtain an allowed dependency or asset directly from its
original upstream release rather than copying it transitively from VDO.Ninja.

### WebSocket server

The inspected `steveseguin/websocket_server` tree contains a standard
[`LICENSE`](https://github.com/steveseguin/websocket_server/blob/eb5a606e855cb4898ee733c1f8408beab298caef/LICENSE)
with the GNU AGPL v3 text. Its README and source headers consistently identify AGPLv3, and no
alternate per-file grant was found in the seven-file pinned tree. The repository does not clearly
state “or later,” so this project treats it conservatively as **AGPL-3.0-only**.

Package dependencies retain their own licenses, but dependency licensing does not relicense the
server's original source. The absence of a lockfile or complete third-party notice in this small
repository is another reason not to transplant its dependency set blindly.

## Useful behavioral reference areas

Use these locations to answer a narrow behavioral question, not as implementation templates:

- [`index.html`](https://github.com/steveseguin/vdo.ninja/blob/4542e4bb2cfafb77e6ad20337126f44fa2b71c9f/index.html):
  application entrypoint, script wiring, and ICE/TURN configuration examples.
- [`main.js`](https://github.com/steveseguin/vdo.ninja/blob/4542e4bb2cfafb77e6ad20337126f44fa2b71c9f/main.js):
  session bootstrap, URL/config selection, ICE-server initialization, and signaling URL handling.
- [`lib.js`](https://github.com/steveseguin/vdo.ninja/blob/4542e4bb2cfafb77e6ad20337126f44fa2b71c9f/lib.js):
  media-device enumeration and recovery, screen-share lifecycle, sender track replacement, bitrate
  control, WebRTC statistics/QoS, ICE/reconnect behavior, WHIP/WHEP, and peer/transceiver handling.
- [`webrtc.js`](https://github.com/steveseguin/vdo.ninja/blob/4542e4bb2cfafb77e6ad20337126f44fa2b71c9f/webrtc.js):
  a minified/obfuscated primary engine. Do not use it as a coding or structural reference.
- [`server.js`](https://github.com/steveseguin/websocket_server/blob/eb5a606e855cb4898ee733c1f8408beab298caef/server.js):
  basic fan-out demonstration; upstream itself says this is unsuitable for an open public server.
- [`vdoninja.js`](https://github.com/steveseguin/websocket_server/blob/eb5a606e855cb4898ee733c1f8408beab298caef/vdoninja.js):
  stateless/custom-WebSocket-server signaling concepts.
- [`vdoninja_advanced.js`](https://github.com/steveseguin/websocket_server/blob/eb5a606e855cb4898ee733c1f8408beab298caef/vdoninja_advanced.js):
  stateful rooms and streams, cleanup, callback queues, notification, parsing, and routing concepts.

For normative behavior, prefer the
[WebRTC specification](https://www.w3.org/TR/webrtc/),
[Media Capture and Streams](https://www.w3.org/TR/mediacapture-streams/),
[Screen Capture specification](https://www.w3.org/TR/screen-capture/), and
[WebSocket protocol](https://www.rfc-editor.org/rfc/rfc6455). An upstream implementation can reveal
questions and edge cases; it does not override a standard or this project's security requirements.

## Independent-implementation workflow

1. State one narrow question, such as how recovery behaves after a video device disappears.
2. Read the applicable standard and platform documentation first.
3. If upstream inspection is still useful, record repository, pinned commit, file and line or symbol,
   the behavioral observation, and the standards source that corroborates it.
4. Close the upstream source. Write a requirement and black-box test in this project's terminology.
5. Implement independently against project abstractions and validate the observable behavior.
6. Review the result for copied names, comments, control flow, constants, wire-format expression,
   fixtures, and assets before merging.

A suitable research note is:

```text
Question:
Normative source:
Reference repository and pinned commit:
Path/symbol inspected:
Behavior observed in original words:
Test written:
Confirmation: no upstream code, comments, assets, or tests copied
```

Do not copy or closely translate source, comments, distinctive naming, control-flow structure,
tests, minified code, translations, UI assets, models, or bundled third-party files. Generic ideas,
protocol facts, and observable behavior can inform an independent implementation, but the boundary
between an idea and protected expression is fact-specific.

If a proposed change needs materially copied or adapted code, stop implementation and request a
documented licensing decision and qualified legal review. Preserving notices, adding SPDX headers,
pinning the exact source, and isolating the code would be required compliance and audit steps after
approval; none of those steps by itself removes AGPL obligations or makes the result independent.
