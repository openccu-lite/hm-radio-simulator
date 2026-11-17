/**
 * rfd while its LAN gateway stays unreachable, in the three ways a gateway can be away: it refuses (RST, the ports
 * closed), it accepts TCP and never says hello (a hung gateway), or it does not answer at all (switched off or
 * unplugged: the SYN goes unanswered). The last one is OpenCCU-Base #375, the lgw-connect-blocks-rpc finding: rfd's
 * reconnect held `mutexULCCommController` across a blocking `connect()`, `IsConnected()` waits for that mutex, so
 * `listBidcosInterfaces` and every RPC call behind it hung until the kernel gave up on the SYN (about 127 s), on every
 * attempt for as long as the gateway stayed away.
 *
 * The unanswered SYN without iptables: a listener that never accepts (listen() with a backlog of 0, perl - the test
 * image has no other tool for it) whose accept queue holds one connection of the test; Linux drops every further SYN
 * to a listener with a full accept queue, so rfd's connect() sits in SYN_SENT and retransmits.
 *
 * Timing assumptions (rfd 2.6.8, LGWPortWrapper.cpp / UnifiedLanCommController.cpp): with a configured IP the
 * reconnect tries again every `basetimeout` = 5 s (the backoff is reset on every pass); a refused connect fails at
 * once, a silent gateway after `waitForState` = 2 s; rfd's connect() has no timeout of its own (the kernel's
 * `tcp_syn_retries` = 6: about 127 s), and a SYN retransmitted after the gateway is back connects (backoff 1-64 s).
 * Margins here are several seconds; ports 2000/2001 are fixed in rfd, so the tests run one after another.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import {spawn} from 'node:child_process';

import {startRfd, withDaemon, skipWithoutDaemons} from '../helpers/daemon.js';
import {regression} from '../helpers/known.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const options = (extra = {}) => ({...skipWithoutDaemons, timeout: 360000, ...extra});
const SERIAL = 'SIM0000375';
const KEY = 'TestLanKey-1234';
const BIDCOS_PORT = 2000;
const sanitized = /(asan|tsan)$/.test(process.env.HMRS_DAEMONS || '');

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

/** CONNECTED of the gateway, or null when rfd did not answer within the timeout. */
async function connectedState(rfd, timeout = 5000) {
    try {
        const interfaces = await rfd.call('listBidcosInterfaces', [], {timeout});
        return interfaces[0]?.CONNECTED === true;
    } catch {
        return null;
    }
}

/** How long an RPC call takes; `ms` is the timeout when it got no answer. */
async function timed(rfd, method, timeout) {
    const at = Date.now();
    try {
        const result = await rfd.call(method, [], {timeout});
        return {ms: Date.now() - at, result};
    } catch (error) {
        return {ms: Date.now() - at, error: String(error.message).slice(0, 80)};
    }
}

/** The local TCP connections to a port in SYN_SENT (/proc/net/tcp, state 02). */
function synSent(port) {
    const hex = port.toString(16).toUpperCase().padStart(4, '0');
    return fs
        .readFileSync('/proc/net/tcp', 'utf8')
        .split('\n')
        .slice(1)
        .filter((line) => {
            const f = line.trim().split(/\s+/);
            return f.length > 3 && f[2].endsWith(`:${hex}`) && f[3] === '02';
        }).length;
}

/** rfd's resources: RSS (kB), threads, descriptors. */
function resources(rfd) {
    const status = fs.readFileSync(`/proc/${rfd.pid}/status`, 'utf8');
    return {
        rssKb: Number(/^VmRSS:\s+(\d+)/m.exec(status)[1]),
        threads: rfd.threads(),
        fds: fs.readdirSync(`/proc/${rfd.pid}/fd`).length,
    };
}

/**
 * rfd's resources between attempts: the lowest threads and descriptors over 3 s of samples - an attempt in progress
 * has a receive thread and a socket of its own for up to 2 s (a silent gateway's `waitForState`).
 */
async function settled(rfd) {
    let low = resources(rfd);
    for (let i = 0; i < 12; i++) {
        await sleep(250);
        const now = resources(rfd);
        low = {rssKb: now.rssKb, threads: Math.min(low.threads, now.threads), fds: Math.min(low.fds, now.fds)};
    }
    return low;
}

/**
 * A listener on 127.0.0.1:port that never accepts, its accept queue filled by one connection: every further SYN is
 * dropped.
 * @returns {Promise<{close: () => Promise<void>}>}
 */
async function blackhole(port) {
    const script =
        'use Socket; $| = 1; socket(S, PF_INET, SOCK_STREAM, 0) or die "socket: $!";' +
        ' setsockopt(S, SOL_SOCKET, SO_REUSEADDR, 1); bind(S, sockaddr_in($ARGV[0], inet_aton("127.0.0.1")))' +
        ' or die "bind: $!"; listen(S, 0) or die "listen: $!"; print "listening\\n"; sleep;';
    const child = spawn('perl', ['-e', script, String(port)], {stdio: ['ignore', 'pipe', 'pipe']});
    let stderr = '';
    child.stderr.on('data', (chunk) => (stderr += chunk));
    await new Promise((resolve, reject) => {
        child.stdout.once('data', resolve);
        child.once('exit', (code) => reject(new Error(`blackhole on ${port} ended (${code}): ${stderr}`)));
    });
    const filler = net.connect(port, '127.0.0.1');
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

/** A gateway that accepts TCP on both ports and never sends a byte. */
async function silentGateway() {
    const sockets = new Set();
    const servers = [];
    for (const port of [2000, 2001]) {
        const server = net.createServer((socket) => {
            sockets.add(socket);
            socket.on('error', () => {});
            socket.on('close', () => sockets.delete(socket));
        });
        await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
        servers.push(server);
    }
    return {
        async close() {
            for (const socket of sockets) {
                socket.destroy();
            }
            for (const server of servers) {
                await new Promise((resolve) => server.close(resolve));
            }
        },
    };
}

async function connectedRfd() {
    const rfd = await startRfd({lgwFront: {serial: SERIAL, key: KEY}});
    await waitUntil(async () => (await connectedState(rfd)) === true, 30000, 'CONNECTED');
    return rfd;
}

test(
    'the gateway does not answer (SYN dropped): rfd answers RPC calls while a reconnect attempt is under way, and reconnects when the gateway is back (#375, the lgw-connect-blocks-rpc finding)',
    options(),
    async (t) => {
        const rfd = await connectedRfd();
        let hole = null;
        await withDaemon(rfd, async () => {
            const {lgw} = rfd;
            const before = resources(rfd);
            await lgw.lose();
            hole = await blackhole(BIDCOS_PORT);
            // rfd's first attempt may still have met the closed port (refused); the next one 5 s later sits in SYN_SENT
            await waitUntil(() => synSent(BIDCOS_PORT) > 0, 30000, "rfd's connect in SYN_SENT");
            await sleep(3000);
            const list = await timed(rfd, 'listBidcosInterfaces', 30000);
            const version = await timed(rfd, 'getVersion', 30000);
            t.diagnostic(
                `during the attempt: listBidcosInterfaces ${list.ms} ms (${list.error ?? `CONNECTED ${list.result?.[0]?.CONNECTED}`}), getVersion ${version.ms} ms; SYN_SENT ${synSent(BIDCOS_PORT)}`,
            );
            await t.test(
                'RPC calls are answered at once during the attempt',
                regression('lgw-connect-blocks-rpc'),
                () => {
                    assert.ok(synSent(BIDCOS_PORT) > 0, 'the attempt was still under way');
                    assert.ok(list.ms < 5000, `listBidcosInterfaces took ${list.ms} ms (${list.error ?? 'answered'})`);
                    assert.equal(list.result?.[0]?.CONNECTED, false);
                    assert.ok(version.ms < 5000, `getVersion took ${version.ms} ms (${version.error ?? 'answered'})`);
                },
            );
            await hole.close();
            hole = null;
            await lgw.reappear();
            const at = Date.now();
            await waitUntil(async () => (await connectedState(rfd, 30000)) === true, 200000, 'CONNECTED again');
            t.diagnostic(`CONNECTED again ${Date.now() - at} ms after the gateway came back`);
            // the keepalive threads start after the coprocessor's restore ("Reconnected.")
            // (and a short-lived thread of the restore may still be running)
            await waitUntil(() => rfd.threads() === before.threads, 30000, 'the threads of before').catch(() => {});
            const after = resources(rfd);
            t.diagnostic(`before ${JSON.stringify(before)}, after ${JSON.stringify(after)}`);
            assert.equal(after.threads, before.threads, 'threads after the reconnect');
            assert.ok(rfd.alive);
        }).finally(() => hole?.close());
    },
);

for (const mode of ['refuses (RST)', 'accepts TCP and never says hello']) {
    test(
        `the gateway ${mode}: many reconnect attempts leave rfd's threads, descriptors and memory flat, RPC calls answered, and it reconnects`,
        options(),
        async (t) => {
            const rfd = await connectedRfd();
            let silent = null;
            await withDaemon(rfd, async () => {
                const {lgw} = rfd;
                await lgw.lose();
                if (mode.startsWith('accepts')) {
                    silent = await silentGateway();
                }
                const failures = () =>
                    rfd.grep(
                        /UnifiedLanCommController::connect\(\): (Unable to connect|Could not connect|Didn't receive)/,
                    ).length;
                await waitUntil(() => failures() >= 2, 30000, 'two failed attempts');
                const start = await settled(rfd);
                const startFailures = failures();
                const slowest = {ms: 0};
                const until = Date.now() + 60000;
                while (Date.now() < until) {
                    const call = await timed(rfd, 'listBidcosInterfaces', 30000);
                    slowest.ms = Math.max(slowest.ms, call.ms);
                    await sleep(1000);
                }
                const end = await settled(rfd);
                const attempts = failures() - startFailures;
                t.diagnostic(
                    `${attempts} attempts in 60 s; start ${JSON.stringify(start)}, end ${JSON.stringify(end)}; slowest listBidcosInterfaces ${slowest.ms} ms`,
                );
                assert.ok(attempts >= 6, `attempts in 60 s: ${attempts}`);
                assert.equal(end.threads, start.threads, 'threads');
                assert.equal(end.fds, start.fds, 'descriptors');
                if (!sanitized) {
                    // ASan's quarantine keeps freed memory for a while; there only threads and descriptors count
                    assert.ok(end.rssKb - start.rssKb < 1024, `RSS grew by ${end.rssKb - start.rssKb} kB`);
                }
                assert.ok(slowest.ms < 5000, `slowest listBidcosInterfaces ${slowest.ms} ms`);
                if (silent) {
                    await silent.close();
                    silent = null;
                }
                await lgw.reappear();
                await waitUntil(async () => (await connectedState(rfd)) === true, 60000, 'CONNECTED again');
                assert.ok(rfd.alive);
            }).finally(() => silent?.close());
        },
    );
}
