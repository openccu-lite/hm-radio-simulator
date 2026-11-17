/**
 * rfd with a LAN gateway that is not there yet when rfd starts - after a power cut the system and the HM-LGW boot
 * together, and the gateway is often the slower one. The lgw-missing-at-start finding: rfd's init gave up on such a
 * gateway for good. `CCU2LGWCommController::init()` returned false when its first connect (or the UDP search for the
 * gateway's serial) failed, and `BidcosInterfaceConcentrator::CreateInterfacesFromFile()` deleted the interface, so
 * nothing was left to reconnect: the gateway stayed away until rfd was restarted, and with the gateway as rfd's only
 * interface rfd exited. A gateway that drops the SYN kept the init in a `connect()` without a timeout for about 127 s,
 * before rfd's RPC loop; a service manager that waits less for rfd's start (openccu-lite: 40 s) kills it.
 *
 * Measured the same with eQ-3's closed-source rfd 2.5.1: the behaviour is eQ-3's, not the source rework's.
 *
 * Timing assumptions (the fix): rfd bounds its gateway connects to `LGW_CONNECT_TIMEOUT_MS` = 10 s; a failed first
 * connect hands the interface to the reconnect, which tries again every `basetimeout` = 5 s with a configured IP (5 s
 * growing by 5 s while a search finds nothing). Without the fix the kernel's `tcp_syn_retries` = 6 gives up after about
 * 127 s. Margins: the start within 20 s, the connect within 45 s of the gateway coming up.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import {spawn} from 'node:child_process';

import {spawnRfd, withDaemon, skipWithoutDaemons, tmpdir, CENTRAL_ADDRESS} from '../helpers/daemon.js';
import {regression, isKnownBroken} from '../helpers/known.js';
import {RadioModule} from '../../lib/module.js';
import {createPtyModule} from '../../lib/pty.js';
import {createLgwFront} from '../../lib/lgw.js';
import {createEq3LanDevice} from '../../lib/eq3udp.js';
import {Air} from '../../lib/air.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const options = (extra = {}) => ({...skipWithoutDaemons, timeout: 360000, ...extra});
const LGW_SERIAL = 'SIMLGW0347';
const KEY = 'TestLanKey0347';
const unfixed = isKnownBroken('lgw-missing-at-start');

async function waitUntil(predicate, timeoutMs, what) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
        if (await predicate()) {
            return Date.now();
        }
        await sleep(250);
    }
    throw new Error(`timeout (${timeoutMs} ms) waiting for ${what}`);
}

/** The gateway's entry of listBidcosInterfaces: undefined when rfd has none, null when rfd did not answer. */
async function gatewayEntry(rfd, timeout = 5000) {
    try {
        const interfaces = await rfd.call('listBidcosInterfaces', [], {timeout});
        return interfaces.find((i) => i.ADDRESS === LGW_SERIAL);
    } catch {
        return null;
    }
}

/** How long after `since` rfd first answers an RPC call; null when it exited or did not answer within `timeoutMs`. */
async function firstAnswer(rfd, since, timeoutMs) {
    const until = since + timeoutMs;
    while (Date.now() < until && rfd.alive) {
        try {
            await rfd.call('system.listMethods', [], {timeout: 2000});
            return Date.now() - since;
        } catch {
            await sleep(250);
        }
    }
    return null;
}

/**
 * How long after `since` rfd writes its pid into `rfd.status` (StatusfileDir), the "started" a service manager waits
 * for (openccu-lite's `occulited radio ready rfd`: 40 s); null when not within `timeoutMs`.
 */
async function statusWritten(rfd, dir, since, timeoutMs) {
    const file = path.join(dir, 'status', 'rfd.status');
    const until = since + timeoutMs;
    while (Date.now() < until && rfd.alive) {
        try {
            if (fs.readFileSync(file, 'utf8').trim() === String(rfd.pid)) {
                return Date.now() - since;
            }
        } catch {
            // not written yet
        }
        await sleep(250);
    }
    return null;
}

/**
 * A listener on host:port that never accepts, its accept queue filled by one connection: every further SYN is
 * dropped, as for a gateway that is switched off (see rfd-lgw-unreachable.test.js).
 */
async function blackhole(host, port) {
    const script =
        'use Socket; $| = 1; socket(S, PF_INET, SOCK_STREAM, 0) or die "socket: $!";' +
        ' setsockopt(S, SOL_SOCKET, SO_REUSEADDR, 1); bind(S, sockaddr_in($ARGV[1], inet_aton($ARGV[0])))' +
        ' or die "bind: $!"; listen(S, 0) or die "listen: $!"; print "listening\\n"; sleep;';
    const child = spawn('perl', ['-e', script, host, String(port)], {stdio: ['ignore', 'pipe', 'pipe']});
    let stderr = '';
    child.stderr.on('data', (chunk) => (stderr += chunk));
    await new Promise((resolve, reject) => {
        child.stdout.once('data', resolve);
        child.once('exit', (code) => reject(new Error(`blackhole on ${host}:${port} ended (${code}): ${stderr}`)));
    });
    const filler = net.connect(port, host);
    filler.on('error', () => {});
    await new Promise((resolve) => filler.once('connect', resolve));
    return {
        async close() {
            filler.destroy();
            const ended = new Promise((resolve) => child.once('exit', resolve));
            child.kill('SIGKILL');
            await ended;
        },
    };
}

/**
 * rfd with an RPI-RF-MOD on a pty (unless `lgwOnly`) and an HM-LGW on 127.0.0.2 that is away at the start: its ports
 * closed (`away: 'refuses'`) or the SYN to 2000 dropped (`away: 'drops'`). Not waited for: the start is what is measured.
 */
async function setup({away, lgwOnly = false}) {
    const dir = tmpdir('hmrs-lgw-start');
    const lgwModule = new RadioModule({serial: LGW_SERIAL});
    const front = await createLgwFront({module: lgwModule, serial: LGW_SERIAL, key: KEY, listen: '127.0.0.2'});
    const interfaces = [];
    const modules = [lgwModule];
    let pty = null;
    if (!lgwOnly) {
        const local = new RadioModule({serial: 'SIMMOD0347'});
        pty = await createPtyModule({module: local, link: path.join(dir, 'uart0')});
        interfaces.push({type: 'CCU2', dev: pty.link});
        modules.push(local);
    }
    interfaces.push({type: 'HMLGW2', serial: LGW_SERIAL, ip: front.host, key: KEY});
    const air = new Air({modules});
    await front.lose();
    let hole = away === 'drops' ? await blackhole(front.host, 2000) : null;
    const startedAt = Date.now();
    const rfd = await spawnRfd({interfaces, dir});
    rfd.lgw = front;
    rfd.pty = pty;
    rfd.air = air;
    return {
        rfd,
        dir,
        lgwModule,
        startedAt,
        async gatewayUp() {
            await hole?.close();
            hole = null;
            await front.reappear();
        },
        async close() {
            await hole?.close();
            hole = null;
            await front.close();
        },
    };
}

for (const away of ['refuses', 'drops']) {
    test(
        `the gateway ${away === 'refuses' ? 'refuses (ports closed)' : 'drops the SYN'} when rfd starts: rfd starts at once, keeps the interface and connects once the gateway is up (#383, the lgw-missing-at-start finding)`,
        options(),
        async (t) => {
            const s = await setup({away});
            await withDaemon(s.rfd, async (rfd) => {
                // without the fix a dropped SYN keeps the init for about 127 s
                const status = statusWritten(rfd, s.dir, s.startedAt, 160000);
                const answered = await firstAnswer(rfd, s.startedAt, 160000);
                const started = await status;
                const entry = answered === null ? null : await gatewayEntry(rfd);
                t.diagnostic(
                    `rfd.status written ${started} ms, first RPC answer ${answered} ms after the start; the gateway after the start: ${entry === undefined ? 'no interface' : JSON.stringify(entry && {CONNECTED: entry.CONNECTED})}`,
                );
                await t.test(
                    'rfd answers within 20 s and lists the gateway as not connected',
                    regression('lgw-missing-at-start'),
                    () => {
                        assert.ok(started !== null && started < 20000, `rfd.status written after ${started} ms`);
                        assert.ok(answered !== null && answered < 20000, `first answer after ${answered} ms`);
                        assert.equal(entry?.CONNECTED, false, 'the gateway in listBidcosInterfaces');
                    },
                );
                if (unfixed) {
                    return;
                }
                assert.equal(s.lgwModule.rfAddress, null, 'no BidCoS address before the gateway is up');
                await sleep(5000);
                await s.gatewayUp();
                const at = Date.now();
                await waitUntil(async () => (await gatewayEntry(rfd))?.CONNECTED === true, 45000, 'CONNECTED');
                t.diagnostic(`CONNECTED ${Date.now() - at} ms after the gateway came up`);
                // what the init would have done: the BidCoS address, the firmware version, the clock
                await waitUntil(() => s.lgwModule.rfAddress === CENTRAL_ADDRESS, 10000, 'the BidCoS address').catch(
                    () => {},
                );
                assert.equal(s.lgwModule.rfAddress, CENTRAL_ADDRESS, "the gateway's module got rfd's BidCoS address");
                const connected = await gatewayEntry(rfd);
                assert.ok(connected?.FIRMWARE_VERSION, `firmware version ${connected?.FIRMWARE_VERSION}`);
                assert.ok(rfd.alive);
            }).finally(() => s.close());
        },
    );
}

test(
    'the gateway is the only interface and refuses when rfd starts: rfd keeps running and connects once the gateway is up (#383, the lgw-missing-at-start finding)',
    options(),
    async (t) => {
        const s = await setup({away: 'refuses', lgwOnly: true});
        await withDaemon(s.rfd, async (rfd) => {
            const answered = await firstAnswer(rfd, s.startedAt, 30000);
            t.diagnostic(
                `first RPC answer ${answered} ms after the start; rfd ${rfd.alive ? 'running' : `exited ${JSON.stringify(rfd.exit)}`}`,
            );
            await t.test('rfd answers and stays up', regression('lgw-missing-at-start'), () => {
                assert.ok(rfd.alive, `rfd exited: ${JSON.stringify(rfd.exit)}`);
                assert.ok(answered !== null && answered < 20000, `first answer after ${answered} ms`);
            });
            if (unfixed) {
                return;
            }
            await s.gatewayUp();
            await waitUntil(async () => (await gatewayEntry(rfd))?.CONNECTED === true, 45000, 'CONNECTED');
            assert.ok(rfd.alive);
        }).finally(() => s.close());
    },
);

test(
    'the gateway (configured by serial only) is not found when rfd starts: rfd keeps the interface, searches again and connects once the gateway answers (#383, the lgw-missing-at-start finding)',
    options(),
    async (t) => {
        // the search: rfd's UDP identify for the serial, then the fixed ports 2000/2001 on the address the gateway
        // reports (udp-search.test.js); the gateway's TCP side is up, its UDP side is not yet
        const dir = tmpdir('hmrs-lgw-search');
        const lgwModule = new RadioModule({serial: LGW_SERIAL});
        const front = await createLgwFront({module: lgwModule, serial: LGW_SERIAL, key: KEY});
        const local = new RadioModule({serial: 'SIMMOD0347'});
        const pty = await createPtyModule({module: local, link: path.join(dir, 'uart0')});
        const air = new Air({modules: [local, lgwModule]});
        let lanDevice = null;
        const startedAt = Date.now();
        const rfd = await spawnRfd({
            interfaces: [
                {type: 'CCU2', dev: pty.link},
                {type: 'HMLGW2', serial: LGW_SERIAL, key: KEY},
            ],
            dir,
        });
        rfd.pty = pty;
        rfd.air = air;
        await withDaemon(rfd, async () => {
            await rfd.waitReady();
            const entry = await gatewayEntry(rfd);
            t.diagnostic(
                `first RPC answer ${Date.now() - startedAt} ms after the start; the gateway after the start: ${entry === undefined ? 'no interface' : JSON.stringify(entry && {CONNECTED: entry.CONNECTED})}`,
            );
            await t.test('rfd lists the gateway as not connected', regression('lgw-missing-at-start'), () => {
                assert.equal(entry?.CONNECTED, false);
            });
            if (unfixed) {
                return;
            }
            lanDevice = await createEq3LanDevice({
                type: 'eQ3-HM-LGW',
                serial: LGW_SERIAL,
                ip: '127.0.0.1',
                services: [[1, 2000]],
            });
            const at = Date.now();
            // the search backoff grows by 5 s per attempt that finds nothing
            await waitUntil(async () => (await gatewayEntry(rfd))?.CONNECTED === true, 90000, 'CONNECTED');
            t.diagnostic(`CONNECTED ${Date.now() - at} ms after the gateway answered the search`);
            // CONNECTED comes with the TCP connection; the address with the coprocessor's restore after it
            await waitUntil(() => lgwModule.rfAddress === CENTRAL_ADDRESS, 10000, 'the BidCoS address').catch(() => {});
            assert.equal(lgwModule.rfAddress, CENTRAL_ADDRESS, "the gateway's module got rfd's BidCoS address");
        }).finally(async () => {
            await lanDevice?.close();
            await front.close();
        });
    },
);
