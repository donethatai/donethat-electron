const { execFile } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');
const log = require('electron-log');

/**
 * Wi-Fi place fingerprinting: reads the set of network names around the machine
 * so the backend can cluster captures into places.
 *
 * Network names and the router's MAC. No BSSIDs, no RSSI (it
 * over-discriminates — it would split an office lobby from its third floor),
 * and no coordinates. On consumer gear the router MAC is close kin to a BSSID,
 * so it ships only once the user has granted location access.
 *
 * Every failure path returns null. This is a best-effort signal; a capture
 * cycle must never fail because a network tool was missing.
 */

const COMMAND_TIMEOUT_MS = 5000;
const MAX_SSIDS = 100;

/**
 * Subnets that mean "you are tethered to a phone". Both are exact — no MAC
 * heuristics — because a wrong guess here silently poisons a real place.
 */
const HOTSPOT_SUBNET_PREFIXES = ['172.20.10.', '192.168.43.'];

/**
 * Interfaces whose gateway must never be used as an identity token.
 *
 * VPN tunnels would collapse every user behind one gateway into a single
 * identity; container bridges have a fixed private gateway on every machine and
 * would invent a place shared by everyone running Docker.
 */
const VIRTUAL_INTERFACE_PATTERNS = [
  /^lo$/i, /^lo\d/i,
  /^utun/i, /^tun/i, /^tap/i, /^wg/i, /^ppp/i, /^ipsec/i,
  /^docker/i, /^veth/i, /^br-/i, /^virbr/i, /^vboxnet/i, /^vmnet/i,
  /^awdl/i, /^llw/i, /^bridge\d/i, /^gif\d/i, /^stf\d/i, /^anpi/i
];

/** Windows reports friendly adapter names, so the filter has to be word-based. */
const VIRTUAL_INTERFACE_NAME_FRAGMENTS = [
  'virtual', 'vethernet', 'vmware', 'hyper-v', 'loopback',
  'vpn', 'tap-', 'tunnel', 'wsl', 'bluetooth', 'teredo', 'virtualbox'
];

function isVirtualInterfaceName(name) {
  if (!name) return true;
  if (VIRTUAL_INTERFACE_PATTERNS.some((pattern) => pattern.test(name))) return true;
  const lowered = name.toLowerCase();
  return VIRTUAL_INTERFACE_NAME_FRAGMENTS.some((fragment) => lowered.includes(fragment));
}

function execText(command, args, options = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = execFile(
        command,
        args,
        {
          timeout: COMMAND_TIMEOUT_MS,
          windowsHide: true,
          maxBuffer: 2 * 1024 * 1024,
          ...options
        },
        (error, stdout, stderr) => {
          if (stderr && String(stderr).trim()) {
            log.info('[networks] helper stderr:', String(stderr).trim());
          }
          if (error && !stdout) {
            resolve(null);
            return;
          }
          resolve(typeof stdout === 'string' ? stdout : String(stdout || ''));
        }
      );
    } catch (error) {
      resolve(null);
      return;
    }
    if (!child) resolve(null);
  });
}

function normalizeMac(value) {
  if (typeof value !== 'string') return null;
  const cleaned = value.trim().toLowerCase().replace(/-/g, ':');
  if (!/^[0-9a-f]{1,2}(:[0-9a-f]{1,2}){5}$/.test(cleaned)) return null;
  const padded = cleaned.split(':').map((part) => part.padStart(2, '0')).join(':');
  // Broadcast and all-zero entries mean "unresolved", not "this network".
  if (padded === 'ff:ff:ff:ff:ff:ff' || padded === '00:00:00:00:00:00') return null;
  return padded;
}

function dedupeSsids(values) {
  const seen = new Set();
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const ssid = value.trim();
    // Hidden networks report an empty SSID; they carry no identity.
    if (!ssid) continue;
    seen.add(ssid);
    if (seen.size >= MAX_SSIDS) break;
  }
  return [...seen];
}

// ---------------------------------------------------------------------------
// Per-platform Wi-Fi scans
// ---------------------------------------------------------------------------

// macOS only: set once a scan comes back without a location grant, cleared
// when the user explicitly asks for permission again.
let darwinScanBlocked = false;

/**
 * The authorization the most recent scan reported. Lets a capture cycle tell a
 * refusal apart from an empty room without paying for a second helper spawn —
 * the scan it already ran carries the answer.
 */
let lastAuthorization = 'unknown';

// Same lookup order as resolveMacMicHelperPath() in audioSessionDetector.js:
// `bin/**/*` is in asarUnpack, so the packaged copy lives under
// app.asar.unpacked.
function resolveHelperPath(name) {
  const suffixes = name === 'wifi-scan'
    ? [path.join(`${name}.app`, 'Contents', 'MacOS', name), name]
    : [name];
  const roots = [
    process.resourcesPath ? path.resolve(process.resourcesPath, 'app.asar.unpacked', 'bin') : null,
    process.resourcesPath ? path.resolve(process.resourcesPath, 'bin') : null,
    path.resolve(process.cwd(), 'bin'),
    path.resolve(__dirname, '..', 'bin')
  ].filter(Boolean);

  for (const root of roots) {
    for (const suffix of suffixes) {
      const candidate = path.join(root, suffix);
      try {
        if (fs.existsSync(candidate)) return candidate;
      } catch (_) {}
    }
  }
  return null;
}

/**
 * macOS: CoreWLAN SSID access is TCC-gated on this helper. `--authorize`
 * raises the Location prompt from the helper's own .app bundle. Capture
 * scans omit that flag but still start CoreLocation in the helper; without
 * that, CoreWLAN returns zero SSIDs even after a grant.
 * @param {boolean} requestAuthorization
 * @returns {Promise<{connectedSsid: string|null, ssids: string[], authorization: string}|null>}
 */
async function scanDarwin(requestAuthorization = false) {
  // Without a grant every cycle would spawn a helper that can only report the
  // same refusal, so stop until the user asks again by re-flipping the toggle.
  if (!requestAuthorization && darwinScanBlocked) return null;

  const helper = resolveHelperPath('wifi-scan');
  if (!helper) {
    log.warn('[networks] wifi-scan helper not found');
    return null;
  }
  if (requestAuthorization) {
    log.info('[networks] authorizing via helper:', helper);
  }

  const stdout = await execText(
    helper,
    requestAuthorization ? ['--authorize'] : [],
    requestAuthorization ? { timeout: 130000 } : { timeout: 8000 }
  );
  if (!stdout) return null;

  let parsed;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch (error) {
    log.warn('[networks] Failed to parse wifi-scan output:', error?.message || error);
    return null;
  }

  const ssids = Array.isArray(parsed.ssids) ? parsed.ssids : [];
  const authorization = typeof parsed.authorization === 'string' ? parsed.authorization : 'unknown';
  lastAuthorization = authorization;
  // Latch only on a definitive refusal. `notDetermined`, `unknown`, or a
  // transient helper failure must stay scannable — treating those as blocked
  // turned one bad spawn into a session-long outage.
  darwinScanBlocked = authorization === 'denied' || authorization === 'restricted';
  if (!requestAuthorization) {
    log.info('[networks] scan result:', JSON.stringify({
      authorization,
      ssidCount: ssids.length,
      connected: typeof parsed.connectedSsid === 'string'
    }));
  }

  return {
    connectedSsid: typeof parsed.connectedSsid === 'string' ? parsed.connectedSsid : null,
    ssids,
    authorization,
    error: typeof parsed.error === 'string' ? parsed.error : null
  };
}

/** nmcli's terse mode backslash-escapes `:` and `\` inside values. */
function unescapeNmcli(value) {
  return value.replace(/\\(.)/g, '$1');
}

/**
 * Linux. NetworkManager may be absent entirely (iwd, systemd-networkd) — that
 * is no signal, not an error.
 * @returns {Promise<{connectedSsid: string|null, ssids: string[]}|null>}
 */
async function scanLinux() {
  // `--rescan no` is mandatory, not cosmetic: nmcli defaults to `auto` and
  // forces a fresh scan whenever it judges the cache stale, which would undo
  // the cached-scan decision on every capture cycle.
  const stdout = await execText('nmcli', ['-t', '-f', 'ACTIVE,SSID', 'dev', 'wifi', 'list', '--rescan', 'no']);
  if (stdout === null) return null;

  const ssids = [];
  let connectedSsid = null;
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    const separator = line.indexOf(':');
    if (separator < 0) continue;
    const active = line.slice(0, separator).trim();
    const ssid = unescapeNmcli(line.slice(separator + 1)).trim();
    if (!ssid) continue;
    ssids.push(ssid);
    if (active === 'yes' && !connectedSsid) connectedSsid = ssid;
  }

  return { connectedSsid, ssids };
}

/**
 * Windows. `netsh` output is localized, so nothing here matches an English
 * field name: `SSID <n> :` and `SSID :` are protocol tokens that survive
 * translation, and no `mode=bssid` is requested (no elevation, no BSSIDs).
 * @returns {Promise<{connectedSsid: string|null, ssids: string[]}|null>}
 */
async function scanWindows() {
  // chcp 65001 first: the default OEM code page mangles non-ASCII SSIDs.
  const networksOut = await execText('cmd.exe', ['/d', '/s', '/c', 'chcp 65001>nul & netsh wlan show networks']);
  if (networksOut === null) return null;

  const ssids = [];
  for (const line of networksOut.split('\n')) {
    const match = /^\s*SSID\s+\d+\s*:\s?(.*)$/.exec(line);
    if (!match) continue;
    const ssid = match[1].trim();
    if (ssid) ssids.push(ssid);
  }

  let connectedSsid = null;
  const interfacesOut = await execText('cmd.exe', ['/d', '/s', '/c', 'chcp 65001>nul & netsh wlan show interfaces']);
  if (interfacesOut) {
    for (const line of interfacesOut.split('\n')) {
      // `\s*SSID` cannot match `BSSID`, so the BSSID row is skipped without
      // relying on a translated label.
      const match = /^\s*SSID\s*:\s?(.*)$/.exec(line);
      if (!match) continue;
      const ssid = match[1].trim();
      if (ssid) {
        connectedSsid = ssid;
        break;
      }
    }
  }

  return { connectedSsid, ssids };
}

// ---------------------------------------------------------------------------
// Gateway MAC — from the physical NIC, never the default route
// ---------------------------------------------------------------------------

function physicalInterfaces() {
  let interfaces = {};
  try {
    interfaces = os.networkInterfaces() || {};
  } catch (_) {
    return [];
  }
  return Object.entries(interfaces)
    .filter(([name]) => !isVirtualInterfaceName(name))
    .map(([name, addresses]) => ({
      name,
      addresses: (addresses || []).filter((entry) => {
        const family = entry.family;
        return (family === 'IPv4' || family === 4) && !entry.internal;
      })
    }))
    .filter((entry) => entry.addresses.length > 0);
}

async function gatewayIpDarwin(interfaceName) {
  const stdout = await execText('route', ['-n', 'get', '-ifscope', interfaceName, 'default']);
  if (!stdout) return null;
  const match = /^\s*gateway:\s*(\S+)\s*$/m.exec(stdout);
  return match ? match[1] : null;
}

async function gatewayIpLinux(interfaceNames) {
  const stdout = await execText('ip', ['-4', 'route', 'show', 'default']);
  if (!stdout) return null;
  for (const line of stdout.split('\n')) {
    const match = /default\s+via\s+(\S+)\s+dev\s+(\S+)/.exec(line);
    if (!match) continue;
    const [, gateway, device] = match;
    if (isVirtualInterfaceName(device)) continue;
    if (interfaceNames.length > 0 && !interfaceNames.includes(device)) continue;
    return { gateway, device };
  }
  return null;
}

async function gatewayIpWindows(interfaces) {
  const stdout = await execText('route', ['print', '-4']);
  if (!stdout) return null;
  const localIps = new Set();
  interfaces.forEach(({ addresses }) => addresses.forEach((entry) => localIps.add(entry.address)));

  for (const line of stdout.split('\n')) {
    // Positional: destination, netmask, gateway, interface IP, metric. The
    // surrounding headers are localized; this row is not.
    const parts = line.trim().split(/\s+/);
    if (parts.length < 4) continue;
    if (parts[0] !== '0.0.0.0' || parts[1] !== '0.0.0.0') continue;
    const gateway = parts[2];
    const interfaceIp = parts[3];
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(gateway)) continue;
    if (!localIps.has(interfaceIp)) continue;
    return gateway;
  }
  return null;
}

async function macForGateway(gatewayIp, interfaceName) {
  if (!gatewayIp) return null;

  if (process.platform === 'linux') {
    const args = interfaceName ?
      ['neigh', 'show', gatewayIp, 'dev', interfaceName] :
      ['neigh', 'show', gatewayIp];
    const stdout = await execText('ip', args);
    if (stdout) {
      const match = /lladdr\s+([0-9a-fA-F:]{11,17})/.exec(stdout);
      if (match) return normalizeMac(match[1]);
    }
    return null;
  }

  if (process.platform === 'darwin') {
    const stdout = await execText('arp', ['-n', gatewayIp]);
    if (!stdout) return null;
    const match = /\bat\s+([0-9a-fA-F:]{11,17})\b/.exec(stdout);
    return match ? normalizeMac(match[1]) : null;
  }

  if (process.platform === 'win32') {
    const stdout = await execText('arp', ['-a', gatewayIp]);
    if (!stdout) return null;
    for (const line of stdout.split('\n')) {
      const parts = line.trim().split(/\s+/);
      if (parts[0] !== gatewayIp) continue;
      const mac = normalizeMac(parts[1]);
      if (mac) return mac;
    }
    return null;
  }

  return null;
}

/**
 * @returns {Promise<{gatewayIp: string|null, gatewayMac: string|null}>}
 */
async function collectGateway() {
  const interfaces = physicalInterfaces();
  if (interfaces.length === 0) return { gatewayIp: null, gatewayMac: null };

  try {
    if (process.platform === 'darwin') {
      for (const { name } of interfaces) {
        const gatewayIp = await gatewayIpDarwin(name);
        if (!gatewayIp) continue;
        return { gatewayIp, gatewayMac: await macForGateway(gatewayIp, name) };
      }
      return { gatewayIp: null, gatewayMac: null };
    }

    if (process.platform === 'linux') {
      const found = await gatewayIpLinux(interfaces.map(({ name }) => name));
      if (!found) return { gatewayIp: null, gatewayMac: null };
      return { gatewayIp: found.gateway, gatewayMac: await macForGateway(found.gateway, found.device) };
    }

    if (process.platform === 'win32') {
      const gatewayIp = await gatewayIpWindows(interfaces);
      if (!gatewayIp) return { gatewayIp: null, gatewayMac: null };
      return { gatewayIp, gatewayMac: await macForGateway(gatewayIp, null) };
    }
  } catch (error) {
    log.warn('[networks] Gateway lookup failed:', error?.message || error);
  }

  return { gatewayIp: null, gatewayMac: null };
}

function isHotspotGateway(gatewayIp) {
  if (typeof gatewayIp !== 'string') return false;
  return HOTSPOT_SUBNET_PREFIXES.some((prefix) => gatewayIp.startsWith(prefix));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

async function scanWifi() {
  if (process.platform === 'darwin') return scanDarwin(false);

  // No location gate off macOS: a scan that produced output was as authorized
  // as it will ever be, and one that failed tells us nothing about a grant.
  const scan = process.platform === 'linux'
    ? await scanLinux()
    : (process.platform === 'win32' ? await scanWindows() : null);
  lastAuthorization = scan ? 'authorized' : 'unavailable';
  return scan;
}

/** @returns {string} authorization from the most recent scan. */
function getLastAuthorization() {
  return lastAuthorization;
}

/**
 * Splits the two signals a scan carries.
 *
 * `authorization` is the OS grant, read from CLAuthorizationStatus inside the
 * helper and independent of whatever the Wi-Fi cache happens to hold.
 * `dataAvailable` is whether that grant actually produced network names.
 * Deriving the grant from `ssidCount > 0` — as this used to — reported "denied"
 * for an Ethernet-only machine with the radio off, and sent people to System
 * Settings to fix a permission that was already granted. It also meant a real
 * denial and an empty room were indistinguishable to every caller.
 *
 * `reason` is the display axis: null when there is nothing to say, otherwise
 * either an authorization state or a hardware state. Only the authorization
 * states warrant a trip to System Settings.
 *
 * @returns {{hasPermission: boolean, authorization: string, dataAvailable: boolean, ssidCount: number, reason: string|null}}
 */
function permissionFromScan(scan) {
  if (!scan) {
    return {
      hasPermission: false,
      authorization: 'unavailable',
      dataAvailable: false,
      ssidCount: 0,
      reason: 'unavailable'
    };
  }

  const ssidCount = (scan.ssids || []).length;
  const dataAvailable = ssidCount > 0;

  // Only macOS gates SSID reads behind Location. Elsewhere a scan that ran at
  // all was authorized, so there is no grant to report and no prompt to raise.
  const authorization = process.platform === 'darwin'
    ? (scan.authorization || 'unknown')
    : 'authorized';
  const hasPermission = authorization === 'authorized';

  let reason = null;
  if (!hasPermission) {
    reason = authorization;
  } else if (scan.error === 'no_wifi_interface') {
    reason = 'noWifi';
  } else if (!dataAvailable) {
    reason = 'noNetworks';
  }

  return { hasPermission, authorization, dataAvailable, ssidCount, reason };
}

/**
 * Collects one Wi-Fi fingerprint for a capture cycle.
 *
 * @returns {Promise<{connectedSsid: string|null, ssids: string[], gatewayMac: string|null}|null>}
 *   null when nothing usable could be read; the backend treats that as unknown.
 */
async function collectNetworkFingerprint() {
  try {
    const scan = await scanWifi();

    // macOS gates network names behind Location. Without that grant the router
    // MAC would be the only thing left to send, and a stable network identity
    // is not what someone who declined the prompt agreed to.
    if (process.platform === 'darwin' && scan?.authorization !== 'authorized') return null;

    const gateway = await collectGateway();

    let ssids = dedupeSsids(scan?.ssids || []);
    let connectedSsid = scan?.connectedSsid || null;
    let gatewayMac = gateway.gatewayMac;

    if (isHotspotGateway(gateway.gatewayIp)) {
      // Tethering. iOS randomises both the hotspot SSID and its MAC per
      // session, so both would be a token seen exactly once. Drop them and
      // cluster on the remaining neighbours: someone tethering at their office
      // still resolves to that office. Nothing about this is sent to the
      // server — a tether with no other networks in range simply arrives as a
      // thin sample and falls through the backend's token floor.
      if (connectedSsid) {
        ssids = ssids.filter((ssid) => ssid !== connectedSsid);
        connectedSsid = null;
      }
      gatewayMac = null;
    }

    if (ssids.length === 0 && !gatewayMac) return null;

    return { connectedSsid, ssids, gatewayMac };
  } catch (error) {
    log.warn('[networks] Failed to collect network fingerprint:', error?.message || error);
    return null;
  }
}

/**
 * macOS: spawn the helper with `--authorize` so CoreLocation can prompt.
 * Linux and Windows need no permission for a cached scan.
 *
 * @returns {Promise<{hasPermission: boolean, authorization: string, dataAvailable: boolean, ssidCount: number, reason: string|null}>}
 */
async function requestLocationPermission() {
  darwinScanBlocked = false;
  if (process.platform === 'darwin') {
    return permissionFromScan(await scanDarwin(true));
  }
  return permissionFromScan(await scanWifi());
}

/**
 * Whether a scan currently returns anything, without raising a prompt.
 * @returns {Promise<{hasPermission: boolean, authorization: string, dataAvailable: boolean, ssidCount: number, reason: string|null}>}
 */
async function checkLocationPermission() {
  // The caller is checking because the grant may have just changed in System
  // Settings, so a cached refusal would answer the wrong question.
  darwinScanBlocked = false;
  return permissionFromScan(await scanWifi());
}

module.exports = {
  collectNetworkFingerprint,
  requestLocationPermission,
  checkLocationPermission,
  getLastAuthorization,
  __test__: {
    permissionFromScan,
    setLastAuthorization(value) {
      lastAuthorization = value;
    },
    setDarwinScanBlocked(value) {
      darwinScanBlocked = !!value;
    },
    isDarwinScanBlocked() {
      return darwinScanBlocked;
    }
  }
};
