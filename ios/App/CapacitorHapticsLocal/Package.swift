// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "CapacitorHaptics",
    platforms: [.iOS(.v15)],
    products: [
        .library(
            name: "CapacitorHaptics",
            targets: ["HapticsPlugin"])
    ],
    dependencies: [
        .package(name: "capacitor-swift-pm", path: "../capacitor-swift-pm-local")
    ],
    targets: [
        .target(
            name: "HapticsPlugin",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm")
            ],
            path: "ios/Sources/HapticsPlugin"),
        .testTarget(
            name: "HapticsPluginTests",
            dependencies: ["HapticsPlugin"],
            path: "ios/Tests/HapticsPluginTests")
    ]
)
