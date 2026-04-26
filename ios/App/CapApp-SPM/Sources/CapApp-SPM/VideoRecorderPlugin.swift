import Foundation
import UIKit
import AVFoundation
import Capacitor

protocol VideoRecorderViewControllerDelegate: AnyObject {
    func videoRecorderDidStartRecording(_ controller: VideoRecorderViewController)
    func videoRecorderDidRequestStop(_ controller: VideoRecorderViewController)
    func videoRecorderDidRequestCancel(_ controller: VideoRecorderViewController)
    func videoRecorder(_ controller: VideoRecorderViewController, didFinishRecordingTo outputURL: URL, durationSeconds: Double, fileSize: UInt64)
    func videoRecorderDidCancel(_ controller: VideoRecorderViewController)
    func videoRecorder(_ controller: VideoRecorderViewController, didFailWith message: String)
}

@objc(VideoRecorderPlugin)
public class VideoRecorderPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "VideoRecorderPlugin"
    public let jsName = "VideoRecorderPlugin"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "presentRecorder", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "completeStop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "dismissRecorder", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cleanupExpiredVideos", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "readVideoFile", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "updateRecordingStats", returnType: CAPPluginReturnPromise)
    ]

    private weak var recorderViewController: VideoRecorderViewController?

    @objc public func presentRecorder(_ call: CAPPluginCall) {
        Task { @MainActor in
        guard let bridge = bridge,
              let presentingViewController = bridge.viewController else {
            call.reject("Bridge view controller unavailable")
            return
        }

        guard recorderViewController == nil else {
            call.reject("Recorder is already open")
            return
        }

        let shooter = call.getString("shooter") ?? ""
        let drill = call.getString("drill") ?? ""
        let session = call.getString("session") ?? ""

        requestPermissions { [weak self] granted, message in
            DispatchQueue.main.async {
                guard let self else { return }

                guard granted else {
                    call.reject(message ?? "Camera and microphone access are required.")
                    return
                }

                let recorder = VideoRecorderViewController(
                    shooter: shooter,
                    drill: drill,
                    session: session
                )
                recorder.delegate = self
                recorder.modalPresentationStyle = .fullScreen

                self.recorderViewController = recorder
                presentingViewController.present(recorder, animated: true) {
                    call.resolve()
                }
            }
        }
        }
    }

    @objc public func completeStop(_ call: CAPPluginCall) {
        Task { @MainActor in
            guard let recorder = recorderViewController else {
                call.reject("Recorder is not active")
                return
            }

            recorder.finishRecordingAfterTimerStop()
            call.resolve()
        }
    }

    @objc public func dismissRecorder(_ call: CAPPluginCall) {
        Task { @MainActor in
            dismissRecorderController(animated: true)
            call.resolve()
        }
    }

    @objc public func cleanupExpiredVideos(_ call: CAPPluginCall) {
        let maxAgeHours = call.getDouble("maxAgeHours") ?? 24

        DispatchQueue.global(qos: .utility).async {
            do {
                let deletedCount = try Self.removeExpiredVideos(maxAgeHours: maxAgeHours)
                call.resolve([
                    "deletedCount": deletedCount
                ])
            } catch {
                call.reject("Failed to clean up expired videos: \(error.localizedDescription)")
            }
        }
    }

    @objc public func readVideoFile(_ call: CAPPluginCall) {
        guard let filePath = call.getString("filePath"), !filePath.isEmpty else {
            call.reject("A filePath is required")
            return
        }

        DispatchQueue.global(qos: .userInitiated).async {
            do {
                let fileURL = URL(fileURLWithPath: filePath)
                let fileData = try Data(contentsOf: fileURL)

                call.resolve([
                    "base64Data": fileData.base64EncodedString(),
                    "fileName": fileURL.lastPathComponent,
                    "mimeType": "video/quicktime",
                    "fileSize": fileData.count
                ])
            } catch {
                call.reject("Failed to read video file: \(error.localizedDescription)")
            }
        }
    }

    @objc public func updateRecordingStats(_ call: CAPPluginCall) {
        let shots = call.getInt("shots") ?? 0
        let totalTime = call.getDouble("totalTime") ?? 0

        Task { @MainActor in
            recorderViewController?.updateStats(shots: shots, totalTime: totalTime)
            call.resolve()
        }
    }

    private func requestPermissions(completion: @escaping (Bool, String?) -> Void) {
        let group = DispatchGroup()
        var cameraGranted = AVCaptureDevice.authorizationStatus(for: .video) == .authorized
        var microphoneGranted = AVCaptureDevice.authorizationStatus(for: .audio) == .authorized

        if AVCaptureDevice.authorizationStatus(for: .video) == .notDetermined {
            group.enter()
            AVCaptureDevice.requestAccess(for: .video) { granted in
                cameraGranted = granted
                group.leave()
            }
        }

        if AVCaptureDevice.authorizationStatus(for: .audio) == .notDetermined {
            group.enter()
            AVCaptureDevice.requestAccess(for: .audio) { granted in
                microphoneGranted = granted
                group.leave()
            }
        }

        group.notify(queue: .main) {
            if cameraGranted && microphoneGranted {
                completion(true, nil)
            } else {
                completion(false, "Camera and microphone access are required for video mode.")
            }
        }
    }

    @MainActor
    private func dismissRecorderController(animated: Bool) {
        guard let recorder = recorderViewController else { return }

        recorder.dismiss(animated: animated)
        recorderViewController = nil
    }

    static func recordingsDirectoryURL() throws -> URL {
        let baseDirectory = try FileManager.default.url(
            for: .cachesDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        )
        .appendingPathComponent("RecordedRuns", isDirectory: true)

        if !FileManager.default.fileExists(atPath: baseDirectory.path) {
            try FileManager.default.createDirectory(at: baseDirectory, withIntermediateDirectories: true)
        }

        return baseDirectory
    }

    private static func removeExpiredVideos(maxAgeHours: Double) throws -> Int {
        let directory = try recordingsDirectoryURL()
        let expirationDate = Date().addingTimeInterval(-(maxAgeHours * 3600))
        let fileURLs = try FileManager.default.contentsOfDirectory(
            at: directory,
            includingPropertiesForKeys: [.contentModificationDateKey, .creationDateKey, .isRegularFileKey],
            options: [.skipsHiddenFiles]
        )

        var deletedCount = 0

        for fileURL in fileURLs {
            let resourceValues = try fileURL.resourceValues(forKeys: [.contentModificationDateKey, .creationDateKey, .isRegularFileKey])
            guard resourceValues.isRegularFile == true else { continue }

            let referenceDate = resourceValues.contentModificationDate ?? resourceValues.creationDate ?? .distantFuture

            if referenceDate < expirationDate {
                try FileManager.default.removeItem(at: fileURL)
                deletedCount += 1
            }
        }

        return deletedCount
    }
}

extension VideoRecorderPlugin: VideoRecorderViewControllerDelegate {
    func videoRecorderDidStartRecording(_ controller: VideoRecorderViewController) {
        notifyListeners("recordingStarted", data: [:])
    }

    func videoRecorderDidRequestStop(_ controller: VideoRecorderViewController) {
        notifyListeners("recordingStopRequested", data: [:])
    }

    func videoRecorder(_ controller: VideoRecorderViewController, didFinishRecordingTo outputURL: URL, durationSeconds: Double, fileSize: UInt64) {
        notifyListeners("recordingFinished", data: [
            "filePath": outputURL.path,
            "fileName": outputURL.lastPathComponent,
            "durationSeconds": durationSeconds,
            "fileSize": fileSize,
            "mimeType": "video/quicktime"
        ])

        Task { @MainActor in
            dismissRecorderController(animated: true)
        }
    }

    func videoRecorderDidCancel(_ controller: VideoRecorderViewController) {
        notifyListeners("recordingCancelled", data: [:])

        Task { @MainActor in
            dismissRecorderController(animated: true)
        }
    }

    func videoRecorder(_ controller: VideoRecorderViewController, didFailWith message: String) {
        notifyListeners("recordingCancelled", data: [
            "message": message
        ])

        Task { @MainActor in
            dismissRecorderController(animated: true)
        }
    }

    func videoRecorderDidRequestCancel(_ controller: VideoRecorderViewController) {
        notifyListeners("recordingCancelRequested", data: [:])
    }
}

final class VideoRecorderViewController: UIViewController, AVCaptureFileOutputRecordingDelegate {
    weak var delegate: VideoRecorderViewControllerDelegate?

    private let shooter: String
    private let drill: String

    private let captureSession = AVCaptureSession()
    private let movieOutput = AVCaptureMovieFileOutput()
    private var previewLayer: AVCaptureVideoPreviewLayer?
    private var pendingOutputURL: URL?
    private var isCancellingRecording = false

    private let topInfoContainer = UIView()
    private let overlayLabel = UILabel()
    private let closeButton = UIButton(type: .system)
    private let actionButton = UIButton(type: .system)
    private let bottomInfoContainer = UIView()
    private let statsStack = UIStackView()
    private let shotsValueLabel = UILabel()
    private let timeValueLabel = UILabel()
    private var isAwaitingTimerStop = false

    init(shooter: String, drill: String, session: String) {
        self.shooter = shooter
        self.drill = drill
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) {
        return nil
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        configureCaptureSession()
        configureOverlay()
        configureControls()
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)

        if !captureSession.isRunning {
            DispatchQueue.global(qos: .userInitiated).async { [weak self] in
                self?.captureSession.startRunning()
            }
        }
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)

        if captureSession.isRunning {
            DispatchQueue.global(qos: .userInitiated).async { [weak self] in
                self?.captureSession.stopRunning()
            }
        }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        previewLayer?.frame = view.bounds
        previewLayer?.cornerRadius = 0
    }

    private func configureCaptureSession() {
        captureSession.beginConfiguration()
        captureSession.sessionPreset = .high

        do {
            guard let videoDevice = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back) else {
                delegate?.videoRecorder(self, didFailWith: "Rear camera unavailable.")
                return
            }

            let videoInput = try AVCaptureDeviceInput(device: videoDevice)
            if captureSession.canAddInput(videoInput) {
                captureSession.addInput(videoInput)
            }

            if let audioDevice = AVCaptureDevice.default(for: .audio) {
                let audioInput = try AVCaptureDeviceInput(device: audioDevice)
                if captureSession.canAddInput(audioInput) {
                    captureSession.addInput(audioInput)
                }
            }

            if captureSession.canAddOutput(movieOutput) {
                captureSession.addOutput(movieOutput)
            }

            captureSession.commitConfiguration()

            let preview = AVCaptureVideoPreviewLayer(session: captureSession)
            preview.videoGravity = .resizeAspectFill
            preview.frame = view.bounds
            view.layer.insertSublayer(preview, at: 0)
            previewLayer = preview
        } catch {
            captureSession.commitConfiguration()
            delegate?.videoRecorder(self, didFailWith: "Unable to configure camera.")
        }
    }

    private func configureOverlay() {
        let topGradient = CAGradientLayer()
        topGradient.colors = [
            UIColor.black.withAlphaComponent(0.34).cgColor,
            UIColor.clear.cgColor
        ]
        topGradient.locations = [0, 1]
        topGradient.frame = CGRect(x: 0, y: 0, width: view.bounds.width, height: 170)
        view.layer.addSublayer(topGradient)

        topInfoContainer.translatesAutoresizingMaskIntoConstraints = false
        topInfoContainer.backgroundColor = UIColor.black.withAlphaComponent(0.34)
        topInfoContainer.layer.cornerRadius = 18
        topInfoContainer.layer.borderWidth = 1
        topInfoContainer.layer.borderColor = UIColor.white.withAlphaComponent(0.14).cgColor
        topInfoContainer.layer.masksToBounds = true

        overlayLabel.translatesAutoresizingMaskIntoConstraints = false
        overlayLabel.numberOfLines = 0
        overlayLabel.textColor = .white
        overlayLabel.font = UIFont.monospacedSystemFont(ofSize: 15, weight: .semibold)
        overlayLabel.backgroundColor = .clear
        overlayLabel.textAlignment = .left
        overlayLabel.text = "Shooter: \(shooter)\nDrill: \(drill)"
        overlayLabel.setContentCompressionResistancePriority(.defaultHigh, for: .horizontal)

        closeButton.translatesAutoresizingMaskIntoConstraints = false
        closeButton.setTitle("✕", for: .normal)
        closeButton.setTitleColor(.white, for: .normal)
        closeButton.titleLabel?.font = UIFont.systemFont(ofSize: 18, weight: .bold)
        closeButton.backgroundColor = UIColor.black.withAlphaComponent(0.34)
        closeButton.layer.cornerRadius = 20
        closeButton.layer.borderWidth = 1
        closeButton.layer.borderColor = UIColor.white.withAlphaComponent(0.14).cgColor
        closeButton.addTarget(self, action: #selector(handleCancelTapped), for: .touchUpInside)
        topInfoContainer.addSubview(overlayLabel)
        view.addSubview(topInfoContainer)
        view.addSubview(closeButton)

        NSLayoutConstraint.activate([
            topInfoContainer.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 8),
            topInfoContainer.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 16),
            topInfoContainer.trailingAnchor.constraint(lessThanOrEqualTo: closeButton.leadingAnchor, constant: -12),

            overlayLabel.topAnchor.constraint(equalTo: topInfoContainer.topAnchor, constant: 11),
            overlayLabel.leadingAnchor.constraint(equalTo: topInfoContainer.leadingAnchor, constant: 14),
            overlayLabel.trailingAnchor.constraint(equalTo: topInfoContainer.trailingAnchor, constant: -14),
            overlayLabel.bottomAnchor.constraint(equalTo: topInfoContainer.bottomAnchor, constant: -11),

            closeButton.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 8),
            closeButton.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -16),
            closeButton.widthAnchor.constraint(equalToConstant: 40),
            closeButton.heightAnchor.constraint(equalToConstant: 40)
        ])
    }

    private func configureControls() {
        configureActionButton(isRecording: false)
        actionButton.translatesAutoresizingMaskIntoConstraints = false
        actionButton.addTarget(self, action: #selector(handleActionTapped), for: .touchUpInside)
        view.addSubview(actionButton)

        bottomInfoContainer.translatesAutoresizingMaskIntoConstraints = false
        bottomInfoContainer.backgroundColor = UIColor.black.withAlphaComponent(0.34)
        bottomInfoContainer.layer.cornerRadius = 22
        bottomInfoContainer.layer.borderWidth = 1
        bottomInfoContainer.layer.borderColor = UIColor.white.withAlphaComponent(0.14).cgColor
        bottomInfoContainer.layer.masksToBounds = true
        view.addSubview(bottomInfoContainer)

        let shotsTitleLabel = makeStatTitleLabel(text: "Shots")
        let timeTitleLabel = makeStatTitleLabel(text: "Time")

        shotsValueLabel.translatesAutoresizingMaskIntoConstraints = false
        shotsValueLabel.textColor = .white
        shotsValueLabel.font = UIFont.monospacedDigitSystemFont(ofSize: 26, weight: .bold)
        shotsValueLabel.text = "0"

        timeValueLabel.translatesAutoresizingMaskIntoConstraints = false
        timeValueLabel.textColor = .white
        timeValueLabel.font = UIFont.monospacedDigitSystemFont(ofSize: 26, weight: .bold)
        timeValueLabel.text = "0.00"

        let leftStack = makeStatStack(titleLabel: shotsTitleLabel, valueLabel: shotsValueLabel)
        let rightStack = makeStatStack(titleLabel: timeTitleLabel, valueLabel: timeValueLabel)
        statsStack.translatesAutoresizingMaskIntoConstraints = false
        statsStack.arrangedSubviews.forEach { $0.removeFromSuperview() }
        statsStack.addArrangedSubview(leftStack)
        statsStack.addArrangedSubview(rightStack)
        statsStack.axis = .horizontal
        statsStack.distribution = .fillEqually
        statsStack.spacing = 10
        bottomInfoContainer.addSubview(statsStack)

        NSLayoutConstraint.activate([
            bottomInfoContainer.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 16),
            bottomInfoContainer.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -16),
            bottomInfoContainer.bottomAnchor.constraint(equalTo: actionButton.topAnchor, constant: -10),

            statsStack.topAnchor.constraint(equalTo: bottomInfoContainer.topAnchor, constant: 12),
            statsStack.leadingAnchor.constraint(equalTo: bottomInfoContainer.leadingAnchor, constant: 12),
            statsStack.trailingAnchor.constraint(equalTo: bottomInfoContainer.trailingAnchor, constant: -12),
            statsStack.bottomAnchor.constraint(equalTo: bottomInfoContainer.bottomAnchor, constant: -12),

            actionButton.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 16),
            actionButton.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -16),
            actionButton.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -16),
            actionButton.heightAnchor.constraint(equalToConstant: 72)
        ])
    }

    private func configureActionButton(isRecording: Bool) {
        actionButton.setTitle(isRecording ? "Stop" : "Start", for: .normal)
        actionButton.setTitleColor(isRecording ? .white : .black, for: .normal)
        actionButton.backgroundColor = isRecording
            ? UIColor(red: 0.73, green: 0.11, blue: 0.11, alpha: 1)
            : UIColor(red: 0.83, green: 0.69, blue: 0.22, alpha: 1)
        actionButton.titleLabel?.font = UIFont.systemFont(ofSize: 23, weight: .bold)
        actionButton.layer.cornerRadius = 24
        actionButton.layer.borderWidth = 1
        actionButton.layer.borderColor = UIColor.white.withAlphaComponent(isRecording ? 0.08 : 0.18).cgColor
        actionButton.layer.shadowColor = UIColor.black.cgColor
        actionButton.layer.shadowOpacity = isRecording ? 0.28 : 0.18
        actionButton.layer.shadowRadius = 18
        actionButton.layer.shadowOffset = CGSize(width: 0, height: 12)
        actionButton.alpha = isAwaitingTimerStop ? 0.7 : 1.0
        actionButton.isEnabled = !isAwaitingTimerStop
    }

    private func makeStatTitleLabel(text: String) -> UILabel {
        let label = UILabel()
        label.translatesAutoresizingMaskIntoConstraints = false
        label.text = text
        label.textColor = UIColor.white.withAlphaComponent(0.68)
        label.font = UIFont.systemFont(ofSize: 12, weight: .semibold)
        label.textAlignment = .center
        return label
    }

    private func makeStatStack(titleLabel: UILabel, valueLabel: UILabel) -> UIStackView {
        let stack = UIStackView(arrangedSubviews: [titleLabel, valueLabel])
        stack.axis = .vertical
        stack.alignment = .center
        stack.spacing = 3
        stack.backgroundColor = UIColor.white.withAlphaComponent(0.04)
        stack.layer.cornerRadius = 16
        stack.isLayoutMarginsRelativeArrangement = true
        stack.layoutMargins = UIEdgeInsets(top: 10, left: 10, bottom: 10, right: 10)
        return stack
    }

    func updateStats(shots: Int, totalTime: Double) {
        let safeShots = max(0, shots)
        let safeTotalTime = max(0, totalTime)
        shotsValueLabel.text = "\(safeShots)"
        timeValueLabel.text = String(format: "%.2f", safeTotalTime)
    }

    @objc
    private func handleActionTapped() {
        if movieOutput.isRecording {
            handleStopTapped()
        } else {
            handleStartTapped()
        }
    }

    @objc
    private func handleStartTapped() {
        guard !movieOutput.isRecording else { return }

        let outputURL: URL

        do {
            outputURL = try VideoRecorderPlugin.recordingsDirectoryURL()
                .appendingPathComponent("run-video-\(UUID().uuidString)")
                .appendingPathExtension("mov")
        } catch {
            delegate?.videoRecorder(self, didFailWith: "Unable to prepare local video storage.")
            return
        }

        try? FileManager.default.removeItem(at: outputURL)
        pendingOutputURL = outputURL

        isAwaitingTimerStop = false
        isCancellingRecording = false
        updateStats(shots: 0, totalTime: 0)
        configureActionButton(isRecording: true)

        movieOutput.startRecording(to: outputURL, recordingDelegate: self)
    }

    @objc
    private func handleStopTapped() {
        guard movieOutput.isRecording else { return }

        isAwaitingTimerStop = true
        configureActionButton(isRecording: true)
        delegate?.videoRecorderDidRequestStop(self)
    }

    @objc
    private func handleCancelTapped() {
        if movieOutput.isRecording {
            isCancellingRecording = true
            delegate?.videoRecorderDidRequestCancel(self)
            movieOutput.stopRecording()
        } else {
            delegate?.videoRecorderDidCancel(self)
        }
    }

    func finishRecordingAfterTimerStop() {
        guard movieOutput.isRecording else { return }
        movieOutput.stopRecording()
    }

    func fileOutput(_ output: AVCaptureFileOutput, didStartRecordingTo fileURL: URL, from connections: [AVCaptureConnection]) {
        isAwaitingTimerStop = false
        configureActionButton(isRecording: true)
        delegate?.videoRecorderDidStartRecording(self)
    }

    func fileOutput(_ output: AVCaptureFileOutput, didFinishRecordingTo outputFileURL: URL, from connections: [AVCaptureConnection], error: Error?) {
        isAwaitingTimerStop = false
        configureActionButton(isRecording: false)

        if isCancellingRecording {
            isCancellingRecording = false
            try? FileManager.default.removeItem(at: outputFileURL)
            delegate?.videoRecorderDidCancel(self)
            return
        }

        if let error {
            delegate?.videoRecorder(self, didFailWith: error.localizedDescription)
            return
        }

        let asset = AVURLAsset(url: outputFileURL)
        let durationSeconds = CMTimeGetSeconds(asset.duration)
        let fileSize = (try? outputFileURL.resourceValues(forKeys: [.fileSizeKey]).fileSize).map(UInt64.init) ?? 0

        delegate?.videoRecorder(
            self,
            didFinishRecordingTo: outputFileURL,
            durationSeconds: durationSeconds.isFinite ? durationSeconds : 0,
            fileSize: fileSize
        )
    }
}
