---
status: reported: https://github.com/OpenCCU/OpenCCU-Base/issues/375
component: rfd, libUnifiedLanComm
refs: [3.89.12 (1372437), main (cf387c1)]
suite: lgw-connect-blocks-rpc
relevance: field # hits users: every installation with an HM-LGW whose gateway is switched off or unplugged; the logic layer, the WebUI and the add-ons stall on rfd for as long as the gateway stays away
---

# An LGW that does not answer blocks rfd's RPC server for about 2 minutes on every reconnect attempt

## What happens

While an HM-LGW does not answer at all (switched off, unplugged, its network down: the SYN goes unanswered), rfd's RPC
server is blocked for about 127 s of every 132 s, for as long as the gateway stays away.

`LGWPortWrapper::reconnectImpl()` holds `mutexULCCommController` across `UnifiedLanCommController::connect()`. That
ends in a blocking `::connect()` without a timeout (`LanConnection::connect()`), which returns only when the kernel gives
up after about 127 s (`tcp_syn_retries` = 6). `IsConnected()` and `WaitForData()` take the same mutex (since #16). With
a configured IP the loop resets its backoff to 5 s on every pass and tries again.

`listBidcosInterfaces` asks `IsConnected()` for `CONNECTED` and waits on the lock; every RPC call queued behind it
waits too. It is not a memory leak: memory, threads, descriptors and sockets stay flat.

Measured with rfd 2.6.8 (3.89.12's code):

- the suite, an LGW that drops the SYN: `listBidcosInterfaces` and `getVersion` unanswered for 30 s (the test's
  timeout) during an attempt; with the fix 0-1 ms;
- a gateway that refuses (RST) or accepts TCP without a hello: no block of minutes; the silent gateway holds the lock for
  `waitForState`'s 2 s (the slowest `listBidcosInterfaces` 3.0 s), with the fix 1 ms;
- 12 refused / 7 silent attempts in 60 s: RSS, threads and descriptors unchanged;
- a Raspberry Pi 3 with a real HM-LGW, its SYNs dropped by a firewall rule: `listBidcosInterfaces` took 124 s;
  `getVersion`, `system.listMethods` and `listDevices` at the same time 75-79 s each.

## How to reproduce

In the suite: `test/daemon/rfd-lgw-unreachable.test.js`, "the gateway does not answer (SYN dropped): ...". The
unanswered SYN comes from a listener that never accepts and whose accept queue is full: Linux drops every further SYN.

## Expected

A reconnect attempt to a gateway that does not answer never blocks the RPC server; `listBidcosInterfaces` reports the
gateway as `CONNECTED: false` at once.

## Cause (public source)

- [LGWPortWrapper.cpp:480-497 at main](https://github.com/OpenCCU/OpenCCU-Base/blob/cf387c11c5ce29a35e3b5edeaf896ce7849b1320/src/rfd/hm2/LGWPortWrapper.cpp#L480-L497):
  the new controller is created and connected under `mutexULCCommController`.
- [LGWPortWrapper.cpp:553-559](https://github.com/OpenCCU/OpenCCU-Base/blob/cf387c11c5ce29a35e3b5edeaf896ce7849b1320/src/rfd/hm2/LGWPortWrapper.cpp#L553-L559):
  `IsConnected()` takes the same mutex.
- [LanConnection.cpp:106](https://github.com/OpenCCU/OpenCCU-Base/blob/cf387c11c5ce29a35e3b5edeaf896ce7849b1320/src/libUnifiedLanComm/src/LanConnection.cpp#L106):
  the blocking `::connect()`.

## Fix

The fork's `fix/375-rfd-lgw-connect-blocks-rpc` (8dffdaa3): build and connect the new controller first, take the lock
only to swap the pointer; the old controller is deleted after the swap as before.
