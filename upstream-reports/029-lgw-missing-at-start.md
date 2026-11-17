---
status: reported: https://github.com/OpenCCU/OpenCCU-Base/issues/383
component: rfd, libUnifiedLanComm
refs: [3.89.12 (1372437), main (cf387c1), rfd 2.5.1 (the closed-source binary)]
suite: lgw-missing-at-start
relevance: field # hits users: every installation with an HM-LGW after a power cut, when the gateway boots slower than the system: the gateway and its devices stay away until rfd is restarted
---

# A LAN gateway that is not reachable when rfd starts is never connected

## What happens

After a power cut the system and the HM-LGW boot together, and the gateway is often the slower one. When rfd cannot
reach the gateway at its start, it gives the interface up for good:

- the gateway refuses (its ports not open yet) or is not found by its serial: rfd starts without the interface and
  never connects it, also not after the gateway is up; `listBidcosInterfaces` does not list it;
- the gateway is rfd's only interface: rfd exits with code 0 ("No BidCoS-Interface available");
- the gateway does not answer at all (the SYN goes unanswered): rfd's start waits in a `connect()` without a timeout,
  about 127 s, before rfd answers any RPC call; then the interface is dropped as above. A service manager that waits
  less for rfd's start kills it, and BidCoS-RF is down until the gateway answers within that time of some start.

The reconnect, which retries a gateway forever, only ever runs for a gateway whose first connect succeeded.

Measured in the suite (an RPI-RF-MOD on a pty and an HM-LGW with a configured IP), with rfd 2.6.8 and the same with
eQ-3's closed-source rfd 2.5.1:

| the gateway at rfd's start    | first RPC answer | the gateway after the start                 | after the gateway is up         |
| ----------------------------- | ---------------- | ------------------------------------------- | ------------------------------- |
| refuses, up after 30 s        | 0.5 s            | not listed                                  | never connected (120 s watched) |
| drops the SYN, up after 30 s  | 36.6 s           | connected (a retransmitted SYN got through) | -                               |
| drops the SYN, up after 170 s | 135.5 s          | not listed                                  | never connected                 |
| reachable, then lost for 20 s | 0.8 s            | connected                                   | connected again after 2 s       |
| refuses, the only interface   | -                | rfd exits 0                                 | -                               |

## How to reproduce

In the suite: `test/daemon/rfd-lgw-missing-at-start.test.js`. The unanswered SYN comes from a listener that never
accepts and whose accept queue is full, as in `rfd-lgw-unreachable.test.js`.

## Expected

rfd starts at once, lists the gateway as `CONNECTED: false` and connects it with its usual reconnect once the gateway
answers.

## Cause (public source)

- [CCU2LGWCommController.cpp:60-91 at main](https://github.com/OpenCCU/OpenCCU-Base/blob/cf387c11c5ce29a35e3b5edeaf896ce7849b1320/src/rfd/hm2/CCU2LGWCommController.cpp#L60-L91):
  `init()` returns false when the search for the serial or the first connect fails ("retry on failure cannot be applied
  here, because it could block whole rfd").
- [BidcosInterfaceConcentrator.cpp:123-127](https://github.com/OpenCCU/OpenCCU-Base/blob/cf387c11c5ce29a35e3b5edeaf896ce7849b1320/src/rfd/BidcosInterfaceConcentrator.cpp#L123-L127):
  an interface whose `Init()` fails is deleted.
- [LanConnection.cpp:106](https://github.com/OpenCCU/OpenCCU-Base/blob/cf387c11c5ce29a35e3b5edeaf896ce7849b1320/src/libUnifiedLanComm/src/LanConnection.cpp#L106):
  the blocking `::connect()`, called during `RFManager::Init()`, before rfd's RPC loop.

## Fix

The fork's `fix/383-rfd-lgw-missing-at-start` (e8ea125d, on top of #375's fix): `init()` keeps the interface when the first connect fails, starts its
receiver and hands it to the existing reconnect; the reconnect's coprocessor restore also sets what the init would have
(the BidCoS address, the firmware version, the clock). rfd bounds its gateway connects to 10 s
(`UnifiedLanCommController::setConnectTimeout()`, new in libUnifiedLanComm; hs485d keeps the blocking connect).
