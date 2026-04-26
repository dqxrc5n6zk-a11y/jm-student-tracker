import Foundation
import UIKit
import AVKit
import AVFoundation
import Capacitor

@objc(RunVideoPlayerPlugin)
public class RunVideoPlayerPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "RunVideoPlayerPlugin"
    public let jsName = "RunVideoPlayerPlugin"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "open", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "close", returnType: CAPPluginReturnPromise)
    ]

    private weak var playerViewController: AVPlayerViewController?
    private var preparedVideoURL: URL?

    @objc public func open(_ call: CAPPluginCall) {
        guard let urlString = call.getString("url"), !urlString.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            call.reject("A video url is required")
            return
        }

        let normalizedURLString = urlString.trimmingCharacters(in: .whitespacesAndNewlines)
        prepareMediaURL(from: normalizedURLString) { [weak self] result in
            switch result {
            case .success(let mediaURL):
                Task { @MainActor in
                    guard let self else { return }
                    guard let bridge = self.bridge,
                          let presentingViewController = bridge.viewController else {
                        call.reject("Bridge view controller unavailable")
                        return
                    }

                    let player = AVPlayer(url: mediaURL)
                    let controller = AVPlayerViewController()
                    controller.player = player
                    controller.modalPresentationStyle = .fullScreen
                    controller.entersFullScreenWhenPlaybackBegins = true
                    controller.exitsFullScreenWhenPlaybackEnds = true

                    self.preparedVideoURL = mediaURL
                    self.playerViewController = controller

                    presentingViewController.present(controller, animated: true) {
                        self.configurePlaybackAudioSession()
                        player.play()
                        call.resolve()
                    }
                }
            case .failure(let error):
                call.reject(error.localizedDescription)
            }
        }
    }

    @objc public func close(_ call: CAPPluginCall) {
        Task { @MainActor in
            guard let controller = playerViewController else {
                call.resolve()
                return
            }

            controller.player?.pause()
            controller.dismiss(animated: true) { [weak self] in
                self?.playerViewController = nil
                self?.cleanupPreparedVideoIfNeeded()
                self?.deactivatePlaybackAudioSession()
                call.resolve()
            }
        }
    }

    private func prepareMediaURL(from urlString: String, completion: @escaping (Result<URL, Error>) -> Void) {
        let trimmed = normalizeVideoURLString(urlString)
        guard !trimmed.isEmpty else {
            completion(.failure(NSError(domain: "RunVideoPlayerPlugin", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "Invalid video url"
            ])))
            return
        }

        print("RunVideoPlayerPlugin normalized URL: \(trimmed)")

        if trimmed.hasPrefix("/") {
            completion(.success(URL(fileURLWithPath: trimmed)))
            return
        }

        guard let remoteOrFileURL = URL(string: trimmed) else {
            completion(.failure(NSError(domain: "RunVideoPlayerPlugin", code: 2, userInfo: [
                NSLocalizedDescriptionKey: "Invalid video url"
            ])))
            return
        }

        if remoteOrFileURL.isFileURL {
            completion(.success(remoteOrFileURL))
            return
        }

        if let scheme = remoteOrFileURL.scheme?.lowercased(), scheme == "http" || scheme == "https" {
            downloadRemoteVideo(from: remoteOrFileURL, completion: completion)
            return
        }

        completion(.success(remoteOrFileURL))
    }

    private func downloadRemoteVideo(from remoteURL: URL, completion: @escaping (Result<URL, Error>) -> Void) {
        let request = URLRequest(url: remoteURL, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 120)

        URLSession.shared.downloadTask(with: request) { [weak self] temporaryURL, response, error in
            if let error {
                print("RunVideoPlayerPlugin download error: \(error.localizedDescription)")
                completion(.failure(error))
                return
            }

            guard let temporaryURL else {
                completion(.failure(NSError(domain: "RunVideoPlayerPlugin", code: 3, userInfo: [
                    NSLocalizedDescriptionKey: "Video download did not return a file"
                ])))
                return
            }

            do {
                let targetURL = try self?.makePreparedVideoURL(from: remoteURL) ?? temporaryURL
                try? FileManager.default.removeItem(at: targetURL)
                try FileManager.default.moveItem(at: temporaryURL, to: targetURL)
                print("RunVideoPlayerPlugin prepared local file: \(targetURL.path)")
                completion(.success(targetURL))
            } catch {
                print("RunVideoPlayerPlugin file move error: \(error.localizedDescription)")
                completion(.failure(error))
            }
        }.resume()
    }

    private func makePreparedVideoURL(from remoteURL: URL) throws -> URL {
        let tempDirectory = FileManager.default.temporaryDirectory.appendingPathComponent("RunVideoPlayer", isDirectory: true)

        if !FileManager.default.fileExists(atPath: tempDirectory.path) {
            try FileManager.default.createDirectory(at: tempDirectory, withIntermediateDirectories: true)
        }

        let providedName = extractRemoteVideoFileName(from: remoteURL)
        let fallbackName = "run-video-\(UUID().uuidString).mov"
        let originalName = sanitizeFileName(providedName).isEmpty ? fallbackName : sanitizeFileName(providedName)
        let hasMovieExtension = (originalName as NSString).pathExtension.isEmpty == false
        let safeName = hasMovieExtension ? originalName : "\(originalName).mov"

        return tempDirectory.appendingPathComponent(safeName)
    }

    private func cleanupPreparedVideoIfNeeded() {
        guard let preparedVideoURL else { return }
        try? FileManager.default.removeItem(at: preparedVideoURL)
        self.preparedVideoURL = nil
    }

    private func configurePlaybackAudioSession() {
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playback, mode: .moviePlayback, options: [])
            try session.setActive(true)
        } catch {
            print("RunVideoPlayerPlugin audio session error: \(error.localizedDescription)")
        }
    }

    private func deactivatePlaybackAudioSession() {
        do {
            try AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
        } catch {
            print("RunVideoPlayerPlugin audio session deactivate error: \(error.localizedDescription)")
        }
    }

    private func normalizeVideoURLString(_ rawValue: String, depth: Int = 0) -> String {
        guard depth < 4 else {
            return rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
        }

        let trimmed = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return "" }

        if trimmed.hasPrefix("/") || trimmed.hasPrefix("file://") {
            return trimmed
        }

        if let components = URLComponents(string: trimmed),
           let srcValue = components.queryItems?.first(where: { $0.name == "src" })?.value,
           !srcValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return normalizeVideoURLString(srcValue, depth: depth + 1)
        }

        if trimmed.lowercased().hasPrefix("http://") || trimmed.lowercased().hasPrefix("https://") {
            return trimmed
        }

        if let decoded = trimmed.removingPercentEncoding,
           decoded != trimmed {
            return normalizeVideoURLString(decoded, depth: depth + 1)
        }

        return trimmed
    }

    private func extractRemoteVideoFileName(from remoteURL: URL) -> String {
        if let components = URLComponents(url: remoteURL, resolvingAgainstBaseURL: false),
           let objectPath = components.path.removingPercentEncoding,
           objectPath.contains("/o/") {
            let storagePath = objectPath.components(separatedBy: "/o/").last ?? ""
            let decodedStoragePath = storagePath.removingPercentEncoding ?? storagePath
            let candidate = (decodedStoragePath as NSString).lastPathComponent
            if !candidate.isEmpty {
                return candidate
            }
        }

        let decodedPath = remoteURL.path.removingPercentEncoding ?? remoteURL.path
        let candidate = (decodedPath as NSString).lastPathComponent
        return candidate.isEmpty ? "run-video.mov" : candidate
    }

    private func sanitizeFileName(_ value: String) -> String {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return "" }

        let invalidCharacters = CharacterSet(charactersIn: "/\\:?%*|\"<>")
        let cleanedScalars = trimmed.unicodeScalars.map { invalidCharacters.contains($0) ? "_" : Character($0) }
        let cleaned = String(cleanedScalars)
        return cleaned.isEmpty ? "" : cleaned
    }
}
