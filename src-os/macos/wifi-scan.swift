import AppKit
import Foundation
import CoreWLAN
import CoreLocation

// CoreWLAN SSID access is TCC-gated on this process. Both modes start
// NSApplication + CLLocationManager: a spawn-read-exit with no location
// session reports notDetermined and returns zero SSIDs, even after a grant
// from a previous --authorize spawn. The prompt still needs a real .app
// bundle (see wifi-scan-Info.plist) whose Contents/MacOS binary is named
// DoneThat — TCC labels Location Services rows after that basename.
//
//   (no args)     use an existing grant; no prompt; 3s cap
//   --authorize   request WhenInUse if needed; 120s cap
//
// Cached results only: a forced rescan interrupts the association, and
// re-association refreshes the cache when the user moves.

struct ScanResult: Codable {
    let ok: Bool
    let authorization: String
    let connectedSsid: String?
    let ssids: [String]
    let error: String?
}

private let scanTimeoutSeconds: TimeInterval = 3
private let authorizeTimeoutSeconds: TimeInterval = 120

func authorizationName(_ status: CLAuthorizationStatus) -> String {
    switch status {
    case .notDetermined:
        return "notDetermined"
    case .restricted:
        return "restricted"
    case .denied:
        return "denied"
    case .authorizedAlways:
        return "authorized"
    case .authorizedWhenInUse:
        return "authorized"
    @unknown default:
        return "unknown"
    }
}

func emit(_ result: ScanResult) {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    if let data = try? encoder.encode(result), let text = String(data: data, encoding: .utf8) {
        print(text)
    } else {
        print("{\"ok\":false,\"authorization\":\"unknown\",\"connectedSsid\":null,\"ssids\":[],\"error\":\"encode_failed\"}")
    }
}

func isAuthorized(_ status: CLAuthorizationStatus) -> Bool {
    switch status {
    case .authorizedAlways:
        return true
    case .authorizedWhenInUse:
        return true
    default:
        return false
    }
}

func readCachedScan(authorization: CLAuthorizationStatus) -> ScanResult {
    let authorizationLabel = authorizationName(authorization)

    guard let interface = CWWiFiClient.shared().interface() else {
        return ScanResult(
            ok: false,
            authorization: authorizationLabel,
            connectedSsid: nil,
            ssids: [],
            error: "no_wifi_interface"
        )
    }

    var names = Set<String>()
    if let networks = interface.cachedScanResults() {
        for network in networks {
            if let ssid = network.ssid, !ssid.isEmpty {
                names.insert(ssid)
            }
        }
    }

    let connected = interface.ssid()
    if let connected = connected, !connected.isEmpty {
        names.insert(connected)
    }

    return ScanResult(
        ok: true,
        authorization: authorizationLabel,
        connectedSsid: (connected?.isEmpty ?? true) ? nil : connected,
        ssids: names.sorted(),
        error: nil
    )
}

final class Scanner: NSObject, CLLocationManagerDelegate {
    private let manager = CLLocationManager()
    private let promptIfNeeded: Bool
    private var settled = false

    init(promptIfNeeded: Bool) {
        self.promptIfNeeded = promptIfNeeded
        super.init()
    }

    func run() {
        manager.delegate = self
        let status = manager.authorizationStatus

        if promptIfNeeded && status == .notDetermined {
            manager.requestWhenInUseAuthorization()
            manager.startUpdatingLocation()
            return
        }

        if isAuthorized(status) {
            // CoreWLAN stays empty unless this process has an active location
            // session — a grant from a previous spawn is not enough.
            manager.startUpdatingLocation()
            return
        }

        settle()
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        let status = manager.authorizationStatus
        if status == .notDetermined { return }
        if isAuthorized(status) {
            manager.startUpdatingLocation()
            return
        }
        settle()
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        settle()
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        // CoreLocation reports a failure immediately while a prompt is still
        // open. Only a determined status means there is nothing left to wait
        // for; no GPS fix still leaves the Wi-Fi cache readable.
        guard manager.authorizationStatus != .notDetermined else { return }
        settle()
    }

    func settle() {
        guard !settled else { return }
        settled = true
        manager.stopUpdatingLocation()
        emit(readCachedScan(authorization: manager.authorizationStatus))
        NSApp.stop(nil)
        exit(0)
    }
}

let prompt = CommandLine.arguments.contains("--authorize")
let scanner = Scanner(promptIfNeeded: prompt)

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
if prompt {
    // CoreLocation alerts need a real activation; otherwise
    // requestWhenInUseAuthorization is a no-op.
    app.activate(ignoringOtherApps: true)
}
scanner.run()
DispatchQueue.main.asyncAfter(deadline: .now() + (prompt ? authorizeTimeoutSeconds : scanTimeoutSeconds)) {
    scanner.settle()
}
app.run()
