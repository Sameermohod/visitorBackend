# Live cameras

The Society Secretary or Admin adds the society's cameras and chooses **exactly who may watch each one**. Residents, tenants and staff see only the cameras they were given, can be given access for a number of days, and every viewing is logged.

## How it works

```
Cameras / NVR ──RTSP──▶  MediaMTX gateway  ──HLS (https)──▶  Browser / phone
(CP Plus, Hikvision,       at the society        ▲                 │
 Dahua, any ONVIF)                               │ "may this person watch?"
                                                 └───── this app ◀─┘ short-lived token
```

1. The Secretary opens **Cameras → Connect cameras** and saves the gateway address.
2. They add each camera (name, place, stream name) and tap **Who can watch** to pick people (and for how long).
3. A person opens **Cameras → Watch live**. The app checks they have access and gives the player a token that lasts 15 minutes (renewed quietly while they watch).
4. The player sends the token with every video request. **The gateway asks this app before it shows anything** (`POST /api/v1/cameras/gateway-auth`), so removing someone's access cuts their picture within seconds, and a viewing can never outlive its token.

Every time someone opens a camera it is written to the **viewing log** (who, when).

## Which cameras work

Research on the Indian market (see sources) found one thing every brand shares: **RTSP / ONVIF**. That is why the primary connection is a vendor-neutral gateway.

| Option | Works with | Notes |
|---|---|---|
| **Society gateway (recommended)** | Any camera or NVR with RTSP/ONVIF: CP Plus, Hikvision, Dahua, Godrej and others | Free open-source [MediaMTX](https://github.com/bluenviron/mediamtx) on a small always-on PC or cloud server. The picture stays on the society's network. No vendor account or approval needed. |
| **Cloud link** | Cameras on a vendor cloud that can produce an HLS link, such as EZVIZ or Imou | The Secretary pastes the HLS link. It is stored encrypted and shown only to people with access. Anyone holding such a link can watch, so keep its expiry short where the vendor allows it. |
| Direct vendor API adapters | Hik-Connect OpenAPI, EZVIZ Open Platform, Imou Open Platform | **Not built yet.** These need a partner/developer account and have region and encryption limits (below). Add one when a society has the credentials to test against. |

### What the research found (and how sure we are)

- **CP Plus is the largest brand in India** (about 48% share per Counterpoint via Reuters, May 2025; other estimates are lower, 20–40%). Hikvision (through Prama Hikvision India) and Dahua together hold roughly 30% or less. We found **no public cloud API for CP Plus**, only local RTSP/HTTP streaming, which the gateway uses. ([Mordor Intelligence](https://www.mordorintelligence.com/industry-reports/india-cctv-market), [SightShield comparison](https://sightshield.in/guides/hikvision-vs-cp-plus), [Whalesbook](https://www.whalesbook.com/news/English/industrial-goodsservices/Indias-CCTV-Market-Revolution-Domestic-Brands-Grab-80percent-Share-as-Chinese-Firms-Exit/69ce41c969ec081354dd062c))
- **EZVIZ** (Hikvision group) has an Open Platform: `POST {areaDomain}/api/lapp/live/address/get` returns an HLS (protocol 2) or RTMP (3) address, with validity from 30 seconds to 720 days. There is an **India developer console** (`iindiaopen.ezviz.com`). **HLS/RTMP only works for cameras with encryption switched off.** The exact India API host was not confirmed; confirm it from your console's area list. ([EZVIZ Open Platform](https://open.ys7.com/help/en/534), [community client](https://github.com/bvis/ezviz-cloud-hass))
- **Imou** (Dahua group): `bindDeviceLive` then `getLiveStreamInfo` return an HLS address, signed requests to `https://openapi-<DataCenter>.easy4ip.com`. Imou warns that anyone with the address can view. We found no reliable information on Imou's availability in India. ([Imou docs](https://open.imoulife.com/book/http/device/live/bindDeviceLive.html))
- **Hikvision Hik-Connect OpenAPI**: a partner programme. You apply for AK/SK credentials, and a normal Hik-Connect login does not work. Reports say encrypted cameras (most modern Hikvision devices) refuse HLS/FLV. ([Hikvision TPP](https://tpp.hikvision.com/products/HC-Integration))
- **Society apps (MyGate, NoBrokerHood, ADDA)**: we found no evidence that they offer resident live CCTV, only gate-camera stills attached to visitor entries.
- **Policy**: India has been tightening rules on (Chinese) CCTV. Reports disagree on the exact dates, so check the current certification requirements before buying new cameras. ([Deccan Herald](https://www.deccanherald.com/amp/story/india%2Fafter-lebanon-pager-blasts-modi-government-to-restrict-use-of-china-made-cctvs-push-for-local-vendors-report-3216398))

### Adding a camera by RTSP link (easiest)

In **Add a camera**, choose **RTSP link** and paste the camera or NVR address, for example `rtsp://USER:PASS@192.168.1.20:554/stream`. The app stores it encrypted and gives the camera its own stream name. Phones and browsers cannot play RTSP themselves, so the gateway still does the conversion:

1. Add the camera with its RTSP link (website: **Cameras → Add a camera**; Android: **Cameras → Add a camera**).
2. Open **Connect cameras** (website) or **Gateway settings** (Android). It shows a ready-made `mediamtx.yml` that already lists every RTSP camera. Only the Admin and Secretary can load it, because it contains the camera passwords (`GET /api/v1/cameras/gateway-config`).
3. Copy it to the gateway and restart MediaMTX. Do this again whenever you add or change an RTSP camera.

The camera must be reachable from the gateway (same society network). The app server never connects to the camera.

> **Not tested** against a live MediaMTX and camera (the RTSP link check and the settings-file generator were tested on their own). Please try one real camera first.

## Setting up the gateway

1. On the NVR/cameras, turn on **RTSP/ONVIF**. Typical stream addresses (check your model):
   - CP Plus / Dahua: `rtsp://USER:PASS@IP:554/cam/realmonitor?channel=1&subtype=1`
   - Hikvision: `rtsp://USER:PASS@IP:554/Streaming/Channels/102`
   - Use the sub-stream (lower quality) for remote viewing: it saves bandwidth.
2. Install MediaMTX on an always-on machine. Example `mediamtx.yml` (the app's **Connect cameras** screen shows this with your own addresses filled in):

```yaml
authMethod: http
authHTTPAddress: https://YOUR-API/api/v1/cameras/gateway-auth
authHTTPExclude:
  - action: api
  - action: metrics
  - action: pprof
hlsAllowOrigins: ['https://YOUR-APP']
paths:
  main-gate:
    source: rtsp://USER:PASSWORD@NVR-IP:554/CAMERA-PATH
    sourceOnDemand: yes
```

3. Serve the HLS port (default 8888) over **https** (for example behind Caddy or a Cloudflare Tunnel). The app is https, so the gateway must be too. Keep the other MediaMTX ports (RTSP 8554, API 9997) closed to the internet.
4. In the app: **Cameras → Connect cameras →** save the gateway address; **Add camera** with the stream name (`main-gate`).

### The gateway contract

MediaMTX posts JSON to `authHTTPAddress` for each request: `user, password, token, ip, action, path, protocol, id, query, userAgent`; a `2xx` answer allows it, and the answer may carry `expireAt` to end the session ([MediaMTX docs](https://mediamtx.org/docs/usage/authentication)). Browsers authenticate with an `Authorization: Bearer <token>` header, which the player adds to every request. This app allows only `action: read` over `hls` or `webrtc`, for the exact stream path the token was issued for.

> **Tested vs not tested.** The endpoint was tested with exactly this documented JSON (49 checks: valid, wrong path, expired, revoked, wrong action, and so on). It has **not** been run against a live MediaMTX with a real camera, because that could not be set up in the build environment. Please do a first end-to-end check with one camera and tell us if MediaMTX sends anything different from its documentation.

## Privacy and legal

This feature shows live pictures of people, so please set it up carefully. These notes come from commentary and vendor guides, not from the law itself; take advice from a lawyer and use your registered bye-laws.

- **Purpose and consent.** Society commentary on India's DPDP Act 2023 says footage of identifiable people is personal data, that blanket approvals do not count as consent, and that consent must be as easy to withdraw as to give. Decide and record the purpose (for example, security of common areas) and tell residents. ([ADDA](https://blog.ind.adda.io/2026/02/dpdp-act-for-housing-societies-guide-for-rwas/), [MyGate](https://mygate.com/blog/society-focus/dpdp-act-for-housing-societies/), [King Stubb & Kasiva](https://ksandk.com/md/data-protection-and-data-privacy/dpdp-act-rwa-compliance-guide/))
- **Only share cameras that cover common areas.** Do not point or share cameras that look into homes.
- **Give the least access that is needed**, for a limited time where you can (the app supports 1–365 days).
- **Use the viewing log.** Review it, and tell viewers it exists (the player says so).
- Whether live sharing with residents needs its own consent was not settled in the sources we found. Ask your lawyer.

## Roles

| Who | Can do |
|---|---|
| Society Admin, Society Secretary | Everything: connect the gateway, add/edit/switch off/remove cameras, choose who watches, read the viewing log, watch every camera |
| Anyone else (resident, tenant, committee, guard, staff, accountant) | Watch only the cameras they were given, until their access ends |

Super Admin has no access to a society's cameras. Cameras are not exposed through the MCP/AI tools.

## Environment

- `API_PUBLIC_URL` should be the public address of this API, so the gateway address shown in **Connect cameras** is correct.
- Keep `ENCRYPTION_KEY` set: cloud-link addresses are encrypted with it.
