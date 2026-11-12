jest.mock('electron-log', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn()
}))

jest.mock('child_process', () => ({ execFile: jest.fn() }))

const childProcess = require('child_process')
const os = require('os')
const networks = require('../captureNetworks')
const { __test__ } = networks
const { permissionFromScan } = __test__

const originalPlatform = process.platform

function setPlatform(value) {
  Object.defineProperty(process, 'platform', { value, configurable: true })
}

afterEach(() => {
  setPlatform(originalPlatform)
})

describe('permissionFromScan on macOS', () => {
  beforeEach(() => setPlatform('darwin'))

  it('reports a grant even when the scan came back empty', () => {
    // The regression this guards: an Ethernet-only desk or a switched-off radio
    // used to read as "denied" and sent the user to System Settings.
    const result = permissionFromScan({ authorization: 'authorized', ssids: [] })

    expect(result.hasPermission).toBe(true)
    expect(result.dataAvailable).toBe(false)
    expect(result.reason).toBe('noNetworks')
  })

  it('reports a grant with no reason when networks are in range', () => {
    const result = permissionFromScan({ authorization: 'authorized', ssids: ['a', 'b'] })

    expect(result).toEqual({
      hasPermission: true,
      authorization: 'authorized',
      dataAvailable: true,
      ssidCount: 2,
      reason: null
    })
  })

  it('separates a missing adapter from a refusal', () => {
    const result = permissionFromScan({
      authorization: 'authorized',
      ssids: [],
      error: 'no_wifi_interface'
    })

    expect(result.hasPermission).toBe(true)
    expect(result.reason).toBe('noWifi')
  })

  it.each(['denied', 'restricted', 'notDetermined'])(
    'passes %s through as both authorization and reason',
    (authorization) => {
      const result = permissionFromScan({ authorization, ssids: [] })

      expect(result.hasPermission).toBe(false)
      expect(result.authorization).toBe(authorization)
      expect(result.reason).toBe(authorization)
    }
  )

  it('treats a helper that reported nothing usable as unknown, not denied', () => {
    const result = permissionFromScan({ ssids: [] })

    expect(result.authorization).toBe('unknown')
    expect(result.reason).toBe('unknown')
  })

  it('reports unavailable when no scan ran at all', () => {
    expect(permissionFromScan(null)).toEqual({
      hasPermission: false,
      authorization: 'unavailable',
      dataAvailable: false,
      ssidCount: 0,
      reason: 'unavailable'
    })
  })
})

describe('permissionFromScan off macOS', () => {
  it.each(['linux', 'win32'])('treats a completed scan on %s as authorized', (platform) => {
    setPlatform(platform)

    // No location gate exists on these platforms, so a scan that ran at all is
    // as granted as it will ever be — there is no prompt to raise.
    const result = permissionFromScan({ ssids: ['office'] })

    expect(result.hasPermission).toBe(true)
    expect(result.authorization).toBe('authorized')
    expect(result.reason).toBeNull()
  })

  it('still flags an empty scan as having no data', () => {
    setPlatform('linux')
    const result = permissionFromScan({ ssids: [] })

    expect(result.hasPermission).toBe(true)
    expect(result.dataAvailable).toBe(false)
    expect(result.reason).toBe('noNetworks')
  })
})

describe('getLastAuthorization', () => {
  it('reports what the most recent scan saw', () => {
    __test__.setLastAuthorization('denied')
    expect(networks.getLastAuthorization()).toBe('denied')
  })

  it('keeps reporting a refusal while scanning stays latched off', () => {
    // scanDarwin short-circuits once blocked, so no fresh value arrives. The
    // capture cycle still needs the last known answer to tell a refusal apart
    // from an empty room.
    __test__.setLastAuthorization('denied')
    __test__.setDarwinScanBlocked(true)

    expect(networks.getLastAuthorization()).toBe('denied')

    __test__.setDarwinScanBlocked(false)
  })
})

describe('collectNetworkFingerprint off macOS', () => {
  afterEach(() => {
    childProcess.execFile.mockReset()
    jest.restoreAllMocks()
  })

  it('keeps the gateway-only fingerprint when the Wi-Fi scanner is missing', async () => {
    // systemd-networkd or iwd machines have no nmcli, but the wired router
    // still identifies the place.
    setPlatform('linux')
    jest.spyOn(os, 'networkInterfaces').mockReturnValue({
      eth0: [{ address: '192.168.1.20', family: 'IPv4', internal: false }]
    })
    childProcess.execFile.mockImplementation((command, args, _options, callback) => {
      if (command === 'nmcli') {
        callback(Object.assign(new Error('spawn nmcli ENOENT'), { code: 'ENOENT' }), '', '')
      } else if (command === 'ip' && args[0] === '-4') {
        callback(null, 'default via 192.168.1.1 dev eth0 proto dhcp\n', '')
      } else if (command === 'ip' && args[0] === 'neigh') {
        callback(null, '192.168.1.1 dev eth0 lladdr aa:bb:cc:dd:ee:ff REACHABLE\n', '')
      } else {
        callback(new Error(`unexpected ${command}`), '', '')
      }
      return {}
    })

    await expect(networks.collectNetworkFingerprint()).resolves.toEqual({
      connectedSsid: null,
      ssids: [],
      gatewayMac: 'aa:bb:cc:dd:ee:ff'
    })
  })
})
