/**
 * One-shot startup probe: is this host's egress actually capable of
 * BitTorrent traffic, or only plain HTTP(S)?
 *
 * Every torrent this run has stalled at 0B/s regardless of seeder count
 * (91, 36, 20, 6 seeders all equally stuck) — that pattern points at
 * network-level UDP/DHT blocking rather than a per-torrent swarm problem.
 * This prints DNS/HTTPS/DHT results tagged [NETDIAG] so `caixote logs` can
 * confirm or rule that out without needing a shell on the host.
 */
import dns from "dns/promises";
import https from "https";
import dgram from "dgram";
import crypto from "crypto";
import net from "net";

const TAG = "[NETDIAG]";
const log = (msg) => console.log(`${TAG} ${msg}`);

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function checkDns(host) {
  try {
    const addrs = await withTimeout(dns.resolve4(host), 4000, "dns");
    log(`dns ${host} -> OK (${addrs.join(", ")})`);
    return true;
  } catch (err) {
    log(`dns ${host} -> FAIL (${err.message})`);
    return false;
  }
}

async function checkHttps(host) {
  return withTimeout(
    new Promise((resolve) => {
      const req = https.get({ host, path: "/", timeout: 4000 }, (res) => {
        log(`https ${host}:443 -> OK (status ${res.statusCode})`);
        res.destroy();
        resolve(true);
      });
      req.on("timeout", () => {
        req.destroy(new Error("request timeout"));
      });
      req.on("error", (err) => {
        log(`https ${host}:443 -> FAIL (${err.message})`);
        resolve(false);
      });
    }),
    5000,
    "https",
  ).catch((err) => {
    log(`https ${host}:443 -> FAIL (${err.message})`);
    return false;
  });
}

// BEP-5 DHT ping over raw UDP. A reachable node replies with its own id -
// any reply at all proves outbound UDP + return traffic works end to end.
function checkDhtUdp(host, port) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket("udp4");
    const tid = "aa";
    const nodeId = crypto.randomBytes(20);
    const packet = Buffer.concat([
      Buffer.from(`d1:ad2:id20:`),
      nodeId,
      Buffer.from(`e1:q4:ping1:t2:${tid}1:y1:qe`),
    ]);

    const finish = (ok, detail) => {
      log(`dht-udp ${host}:${port} -> ${ok ? "OK" : "FAIL"}${detail ? ` (${detail})` : ""}`);
      try {
        socket.close();
      } catch {}
      resolve(ok);
    };

    const timer = setTimeout(() => finish(false, "no reply within 4000ms"), 4000);
    socket.on("message", (msg) => {
      clearTimeout(timer);
      finish(true, `${msg.length}B reply`);
    });
    socket.on("error", (err) => {
      clearTimeout(timer);
      finish(false, err.message);
    });
    socket.send(packet, port, host, (err) => {
      if (err) {
        clearTimeout(timer);
        finish(false, `send error: ${err.message}`);
      }
    });
  });
}

// Plain TCP handshake to a *nonstandard* port - distinguishes "outbound UDP
// specifically is blocked" (torrents could still work via HTTP trackers +
// TCP peer connections) from "everything except 53/80/443 is blocked" (no
// torrent, however well-seeded or well-tracked, can ever work here).
// ECONNREFUSED still proves the path is open end-to-end (the packet reached
// the host and got a RST back) even though nothing's listening there - only
// a bare timeout is consistent with silent firewall filtering.
function checkTcpConnect(host, port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port, timeout: 4000 });
    const finish = (ok, detail) => {
      log(`tcp ${host}:${port} -> ${ok ? "OK" : "FAIL"}${detail ? ` (${detail})` : ""}`);
      socket.destroy();
      resolve(ok);
    };
    socket.on("connect", () => finish(true, "connected"));
    socket.on("timeout", () => finish(false, "no response within 4000ms - likely filtered"));
    socket.on("error", (err) => {
      // ECONNREFUSED means a RST came back - the path itself is open, just
      // nothing listening on this exact port. Treat as a pass for "is this
      // port range reachable at all," same signal a real open port gives.
      finish(err.code === "ECONNREFUSED", err.code || err.message);
    });
  });
}

export async function runNetworkDiagnostics() {
  log("starting egress probe (dns / https / dht-udp / tcp-highport)");
  const started = Date.now();

  const [dnsOk, httpsOk, dht1, dht2, tcpTracker, tcpAnchor] = await Promise.allSettled([
    checkDns("router.bittorrent.com"),
    checkHttps("1.1.1.1"),
    checkDhtUdp("router.bittorrent.com", 6881),
    checkDhtUdp("dht.transmissionbt.com", 6881),
    // Real public HTTP-capable tracker on its actual nonstandard TCP port -
    // if torrents with an http:// tracker in their magnet can reach this,
    // they can still find peers even with DHT/UDP fully blocked. Public
    // trackers are individually flaky though (confirmed: this one alone
    // timed out from a known-good home network with no firewall issue), so
    // it's not trusted alone - github.com:22 is the reliability anchor: an
    // always-up service on an equally nonstandard port, verified live to
    // succeed from an unrestricted network. If *that* also fails here, the
    // block is general (any nonstandard port), not this one tracker being
    // unreachable today.
    checkTcpConnect("tracker.opentrackr.org", 1337),
    checkTcpConnect("github.com", 22),
  ]);

  const dhtWorks =
    (dht1.status === "fulfilled" && dht1.value) || (dht2.status === "fulfilled" && dht2.value);
  const httpsWorks = httpsOk.status === "fulfilled" && httpsOk.value;
  const dnsWorks = dnsOk.status === "fulfilled" && dnsOk.value;
  const tcpHighPortWorks =
    (tcpTracker.status === "fulfilled" && tcpTracker.value) ||
    (tcpAnchor.status === "fulfilled" && tcpAnchor.value);

  if (!dnsWorks) {
    log("VERDICT: DNS resolution itself is failing — check the container's resolv.conf/DNS egress first.");
  } else if (dhtWorks) {
    log("VERDICT: DHT UDP round-trip succeeded — egress isn't the blocker, look elsewhere (peer TCP, disk, etc).");
  } else if (httpsWorks && tcpHighPortWorks) {
    log(
      "VERDICT: DNS/HTTPS work, DHT UDP fails, but nonstandard-port TCP works — outbound UDP " +
        "specifically looks blocked, not the whole port range. Torrents with a working http:// " +
        "tracker in their magnet should still be able to find and reach peers over TCP.",
    );
  } else if (httpsWorks && !tcpHighPortWorks) {
    log(
      "VERDICT: only standard ports (53/443) reach out — DNS/HTTPS work but BOTH UDP and TCP on " +
        "nonstandard ports fail. This looks like a narrow egress allowlist (53/80/443 only), not a " +
        "BitTorrent-specific block. No torrent can work here regardless of tracker type or seeder " +
        "count until this host's outbound port range is widened, or the workload moves to a host " +
        "without this restriction.",
    );
  } else {
    log("VERDICT: inconclusive — see individual probe results above.");
  }

  log(`egress probe finished in ${Date.now() - started}ms`);
}
